import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEventHub, HUB_BATCH } from "../src/services/event-hub.js";
import type { Store } from "../src/store/types.js";
import { metrics } from "../src/telemetry/metrics.js";
import { makeTestApp, type TestApp } from "./fixtures/app.js";
import {
  createSftRun,
  FakeWorker,
  type ClaimedJob,
} from "./fixtures/worker.js";

interface Frame {
  event: string;
  id: number | null;
  data: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const until = async (
  what: string,
  cond: () => boolean,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
};

/** Reads an SSE response frame by frame until it ends or `close()`. */
const openSse = async (t: TestApp, path: string, lastEventId?: number) => {
  const res = await t.request(path, {
    headers: {
      Accept: "text/event-stream",
      ...(lastEventId ? { "Last-Event-ID": String(lastEventId) } : {}),
    },
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  const state = { ended: false, pings: 0 };
  let buffer = "";
  const done = (async () => {
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (raw.startsWith(":")) {
          state.pings += 1;
          continue;
        }
        const field = (name: string) =>
          raw
            .split("\n")
            .find((l) => l.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        const id = field("id");
        frames.push({
          event: field("event") ?? "message",
          id: id === undefined ? null : Number(id),
          data: JSON.parse(field("data") ?? "{}") as Record<string, unknown>,
        });
      }
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      state.ended = true;
    });

  return {
    frames,
    state,
    done,
    close: async () => {
      await reader.cancel().catch(() => undefined);
      await done;
    },
  };
};

const metricSteps = (frames: Frame[]) =>
  frames
    .filter((f) => f.event === "metric")
    .map(
      (f) =>
        (f.data.metric as { step: number } | undefined)?.step ?? f.data.step,
    );

/** Counts the store calls the SSE path makes. */
const countQueries = (store: Store) => {
  const counts = { listEventsSince: 0, jobStates: 0, listEvents: 0 };
  const jobs = store.jobs;
  for (const name of Object.keys(counts) as Array<keyof typeof counts>) {
    const original = jobs[name].bind(jobs) as (...a: unknown[]) => unknown;
    (jobs as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
      counts[name] += 1;
      return original(...a);
    };
  }

  return counts;
};

const untilListening = async (value: 0 | 1) => {
  const deadline = Date.now() + 5_000;
  while ((await metrics.sseHubListening.get()).values[0]?.value !== value) {
    if (Date.now() > deadline)
      throw new Error(`grad_sse_hub_listening != ${value}`);
    await sleep(10);
  }
};

const dispatched = async (): Promise<number> =>
  (await metrics.sseDispatchLatency.get()).values.find(
    (v) => v.metricName === "grad_sse_dispatch_latency_seconds_count",
  )?.value ?? 0;

const openStreams = async (): Promise<number> =>
  (await metrics.sseStreams.get()).values[0]?.value ?? 0;

describe("SSE event hub (one reader per replica)", () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeTestApp({
      settings: {
        maxAttempts: 3,
        evalConcurrency: 2,
        // Only notifications deliver within a test unless it says otherwise.
        ssePollMs: 60_000,
        sseStreamsPerKey: 200,
      },
    });
  });

  afterEach(async () => {
    await t.close();
  });

  const startRuns = async (n: number) => {
    const jobs: Array<{ run: string; job: ClaimedJob; worker: FakeWorker }> =
      [];
    for (let i = 0; i < n; i += 1) {
      const run = await createSftRun(t, { name: `fan-${i}` });
      const worker = new FakeWorker(t, `worker-${i}`);
      const job = (await worker.claim())!;
      expect(job.id).toBe(run.id);
      jobs.push({ run: run.id, job, worker });
    }

    return jobs;
  };

  it("fans 100 streams over 5 running jobs out of one hub: queries track writes, not streams", async () => {
    const jobs = await startRuns(5);
    const counts = countQueries(t.deps.store);
    const streamsBefore = await openStreams();
    const dispatchedBefore = await dispatched();

    const streams = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        openSse(t, `/v1/runs/${jobs[i % 5]!.run}/events`),
      ),
    );
    // Backfill from the start: each run's queued and starting phases.
    await until("backfill", () =>
      streams.every(
        (s) => s.frames.filter((f) => f.event === "phase").length >= 2,
      ),
    );
    expect(await openStreams()).toBe(streamsBefore + 100);
    expect(t.services.events.size()).toEqual({ jobs: 5, subscriptions: 100 });
    const backfillFetches = counts.listEventsSince;
    // Backfilled rows are not timed as dispatches; live ones are.
    expect(await dispatched()).toBe(dispatchedBefore);
    expect(backfillFetches).toBeLessThan(20);

    for (let step = 1; step <= 5; step += 1) {
      for (const { job, worker } of jobs)
        await worker.progress(job, step, step * 10);
    }
    await until("every metric on every stream", () =>
      streams.every((s) => metricSteps(s.frames).length === 5),
    );
    for (const s of streams)
      expect(metricSteps(s.frames)).toEqual([1, 2, 3, 4, 5]);
    // 25 writes; 100 per-stream pollers would be 100 queries per interval.
    expect(counts.listEventsSince - backfillFetches).toBeLessThanOrEqual(25);
    expect(counts.jobStates).toBe(counts.listEventsSince);
    expect(counts.listEvents).toBe(0);
    expect(await dispatched()).toBe(dispatchedBefore + 25);

    for (const { job, worker } of jobs) {
      await worker.complete(
        job,
        { status: "completed", tokens_processed: 50 },
        "art",
      );
    }
    await Promise.all(streams.map((s) => s.done));
    for (const s of streams) {
      expect(s.frames.at(-1)).toMatchObject({
        event: "completed",
        id: null,
        data: { status: "completed" },
      });
      const ids = s.frames.flatMap((f) => (f.id === null ? [] : [f.id]));
      expect(new Set(ids).size).toBe(ids.length);
    }
    await until("hub cleanup", () => t.services.events.size().jobs === 0);
    expect(t.services.events.size()).toEqual({ jobs: 0, subscriptions: 0 });
    expect(await openStreams()).toBe(streamsBefore);
  });

  it("loses and repeats nothing across reconnects with Last-Event-ID", async () => {
    const { run, job, worker } = (await startRuns(1))[0]!;
    await worker.progress(job, 1, 10);
    const first = await openSse(t, `/v1/runs/${run}/metrics`);
    await until("step 1", () => metricSteps(first.frames).length === 1);
    await worker.progress(job, 2, 20);
    await until("step 2", () => metricSteps(first.frames).length === 2);
    await first.close();

    // Written while disconnected.
    await worker.progress(job, 3, 30);
    await worker.progress(job, 4, 40);
    const lastId = first.frames.at(-1)!.id!;
    const second = await openSse(t, `/v1/runs/${run}/metrics`, lastId);
    await until("steps 3-4", () => metricSteps(second.frames).length === 2);
    await second.close();
    await worker.progress(job, 5, 50);
    const third = await openSse(
      t,
      `/v1/runs/${run}/metrics`,
      second.frames.at(-1)!.id!,
    );
    await worker.complete(
      job,
      { status: "completed", tokens_processed: 50 },
      "art",
    );
    await third.done;

    const all = [...first.frames, ...second.frames, ...third.frames];
    expect(metricSteps(all)).toEqual([1, 2, 3, 4, 5]);
    const ids = all.flatMap((f) => (f.id === null ? [] : [f.id]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(third.frames.at(-1)!.event).toBe("status");
    await until(
      "hub cleanup",
      () => t.services.events.size().subscriptions === 0,
    );
  });

  it("delivers on the safety poll when every notification is lost", async () => {
    const { job } = (await startRuns(1))[0]!;
    const deaf: Pick<Store, "jobs" | "listen"> = {
      jobs: t.deps.store.jobs,
      listen: async () => async () => undefined,
    };
    const hub = createEventHub(deaf, { pollMs: 100, clock: t.clock });
    try {
      const sub = hub.subscribe(job.id, 0);
      const backfill = await sub.next(5_000);
      const lastSeq = backfill!.events.at(-1)!.seq;
      const polls =
        (await metrics.sseHubFetches.get()).values.find(
          (v) => v.labels.reason === "poll",
        )?.value ?? 0;
      await t.deps.store.jobs.appendEvent({
        jobId: job.id,
        attempt: job.attempt,
        type: "log",
        step: 0,
        key: "missed-notify",
        payload: { message: "hello" },
      });
      const started = Date.now();
      const batch = await sub.next(5_000);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(batch!.events).toHaveLength(1);
      expect(batch!.events[0]).toMatchObject({
        type: "log",
        seq: expect.any(Number),
      });
      expect(batch!.events[0]!.seq).toBeGreaterThan(lastSeq);
      const pollsAfter =
        (await metrics.sseHubFetches.get()).values.find(
          (v) => v.labels.reason === "poll",
        )?.value ?? 0;
      expect(pollsAfter).toBeGreaterThan(polls);
      // Nothing new: the wait times out empty.
      expect(await sub.next(150)).toEqual({ events: [], settled: false });
      sub.close();
      expect(hub.size()).toEqual({ jobs: 0, subscriptions: 0 });
      expect(await sub.next(10)).toBeNull();
    } finally {
      await hub.close();
    }
  });

  it("listens again after the LISTEN connection drops, and polls meanwhile", async () => {
    const { job } = (await startRuns(1))[0]!;
    const lost: Array<(e: Error) => void> = [];
    const closers: Array<() => Promise<void>> = [];
    let failNext = true;
    const flaky: Pick<Store, "jobs" | "listen"> = {
      jobs: t.deps.store.jobs,
      listen: async (channel, onPayload, onLost) => {
        if (failNext) {
          failNext = false;
          throw new Error("connection refused");
        }
        lost.push(onLost);
        const close = await t.deps.store.listen(channel, onPayload, onLost);
        closers.push(close);
        return close;
      },
    };
    const hub = createEventHub(flaky, { pollMs: 60_000, clock: t.clock });
    try {
      const sub = hub.subscribe(job.id, 0);
      const backfill = await sub.next(5_000);
      expect(backfill!.events.length).toBeGreaterThan(0);
      // The first LISTEN failed; the retry (after 1 s) succeeds.
      await untilListening(1);

      await t.deps.store.jobs.appendEvent({
        jobId: job.id,
        attempt: job.attempt,
        type: "log",
        step: 0,
        key: "via-notify",
        payload: { message: "a" },
      });
      expect((await sub.next(2_000))!.events).toHaveLength(1);

      // The connection dies: the hub listens again and catches up at once.
      await closers[0]!();
      lost[0]!(new Error("terminated"));
      expect((await metrics.sseHubListening.get()).values[0]?.value).toBe(0);
      await t.deps.store.jobs.appendEvent({
        jobId: job.id,
        attempt: job.attempt,
        type: "log",
        step: 0,
        key: "while-down",
        payload: { message: "b" },
      });
      await untilListening(1);
      expect(lost).toHaveLength(2);
      const caughtUp = await sub.next(2_000);
      expect(caughtUp!.events.map((e) => e.payload.message)).toEqual(["b"]);
    } finally {
      await hub.close();
    }
  });

  it("pages a long backlog through bounded fetches, in order", async () => {
    const { job } = (await startRuns(1))[0]!;
    const total = HUB_BATCH * 2 + 37;
    for (let i = 0; i < total; i += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, total - i) }, (_, k) =>
          t.deps.store.jobs.appendEvent({
            jobId: job.id,
            attempt: job.attempt,
            type: "log",
            step: 0,
            key: `bulk-${i + k}`,
            payload: { message: "x" },
          }),
        ),
      );
    }
    const sub = t.services.events.subscribe(job.id, 0);
    const seqs: number[] = [];
    while (seqs.length < total) {
      const batch = await sub.next(5_000);
      expect(batch!.events.length).toBeGreaterThan(0);
      expect(batch!.events.length).toBeLessThanOrEqual(2 * HUB_BATCH);
      seqs.push(
        ...batch!.events.filter((e) => e.type === "log").map((e) => e.seq),
      );
    }
    expect(seqs).toHaveLength(total);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    sub.close();
  });

  it("frees subscriptions when clients disconnect, and ends every stream when the hub closes", async () => {
    const { run } = (await startRuns(1))[0]!;
    const before = await openStreams();
    const dropped = await Promise.all(
      Array.from({ length: 10 }, () => openSse(t, `/v1/runs/${run}/events`)),
    );
    await until(
      "subscribed",
      () => t.services.events.size().subscriptions === 10,
    );
    await Promise.all(dropped.map((s) => s.close()));
    await until(
      "unsubscribed",
      () => t.services.events.size().subscriptions === 0,
    );
    expect(t.services.events.size()).toEqual({ jobs: 0, subscriptions: 0 });
    expect(await openStreams()).toBe(before);

    // SIGTERM: the hub closes, open streams end (clients resume elsewhere).
    const open = await Promise.all(
      Array.from({ length: 3 }, () => openSse(t, `/v1/runs/${run}/events`)),
    );
    await until(
      "subscribed",
      () => t.services.events.size().subscriptions === 3,
    );
    await t.services.events.close();
    await Promise.all(open.map((s) => s.done));
    for (const s of open)
      expect(s.frames.some((f) => f.event === "completed")).toBe(false);
    const late = await openSse(t, `/v1/runs/${run}/events`);
    await late.done;
    expect(late.frames).toEqual([]);
  });

  it("reaches a stream on another replica (both read Postgres)", async () => {
    const { run, job, worker } = (await startRuns(1))[0]!;
    const replicaB = await makeTestApp({
      store: t.deps.store,
      clock: t.clock,
      settings: { maxAttempts: 3, evalConcurrency: 2, ssePollMs: 60_000 },
    });
    try {
      const stream = await openSse(replicaB, `/v1/runs/${run}/events`);
      await until("backfill", () => stream.frames.length >= 2);
      await worker.progress(job, 1, 10);
      await until(
        "metric via replica A",
        () => metricSteps(stream.frames).length === 1,
      );
      await worker.complete(
        job,
        { status: "completed", tokens_processed: 10 },
        "art",
      );
      await stream.done;
      expect(stream.frames.at(-1)!.event).toBe("completed");
    } finally {
      await replicaB.close();
    }
  });
});
