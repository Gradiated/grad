import { describe, expect, it } from "vitest";

import { NotFoundError, ResponseDecodeError, ServerError, type RunEvent, type RunStatus } from "../src/index.js";
import { MAX_EVENT_RECONNECTS } from "../src/resources/runs.js";
import { FakeServer, json, makeGrad, problemFixture, wire } from "./helpers.js";

const page = wire<{ run_id: string; data: Array<{ type: string; seq: number; run: Record<string, unknown> }> }>("run-events-page.json");
const RUN = `/v1/runs/${page.run_id}`;
const finalRun = page.data.at(-1)?.run as Record<string, unknown> & { artifact_id: string };
const blocks = wire<string>("run-events.sse").split("\n\n").filter(Boolean);
const sse = (list: string[]) => new Response(`${list.join("\n\n")}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
const queuedRun = { ...finalRun, status: "queued", phase: "queued", artifact_id: null, finished_at: null };

describe("run events", () => {
  it("fails on a JSON answer to the event stream instead of reconnecting forever", async () => {
    // A proxy or cache that ignores Accept hands back the JSON page; it parsed as an empty stream.
    const server = new FakeServer().on("GET", `${RUN}/events`, json(page));
    const { grad } = makeGrad(server, { maxRetries: 0 });
    const error = await (async () => {
      for await (const _ of grad.runs.events(page.run_id, { follow: true })) void _;
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponseDecodeError);
    expect((error as ResponseDecodeError).code).toBe("not_event_stream");
    expect(server.callsTo("GET", `${RUN}/events`)).toHaveLength(1);
  });

  it("gives up after MAX_EVENT_RECONNECTS failed reconnects in a row", async () => {
    const server = new FakeServer().on("GET", `${RUN}/events`, json({}, 502));
    const { grad } = makeGrad(server, { maxRetries: 0 });
    const error = await (async () => {
      for await (const _ of grad.runs.events(page.run_id, { follow: true })) void _;
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(server.callsTo("GET", `${RUN}/events`)).toHaveLength(MAX_EVENT_RECONNECTS + 1);
  });

  it("follows the typed event stream, reconnecting with Last-Event-ID without repeating events", async () => {
    const server = new FakeServer()
      // Drop after 8 events, then replay a duplicate before the rest (a proxy that re-sent one).
      .on("GET", `${RUN}/events`, sse(blocks.slice(0, 8)), json({}, 502), sse(blocks.slice(7)))
      .on("GET", RUN, json(queuedRun));
    const { grad, clock } = makeGrad(server, { maxRetries: 0 });
    const events: RunEvent[] = [];
    for await (const ev of grad.runs.events(page.run_id, { follow: true })) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(page.data.map((e) => e.type));
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length - 1); // completed repeats the last seq
    const calls = server.callsTo("GET", `${RUN}/events`);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(calls[0]?.headers.has("last-event-id")).toBe(false);
    expect(calls[2]?.headers.get("last-event-id")).toBe(String(page.data[7]?.seq));
    expect(clock.sleeps).toEqual([500, 1000]);

    const [phase, , waiting, , starting] = events;
    if (phase?.type !== "phase" || waiting?.type !== "phase" || starting?.type !== "phase") throw new Error("expected phases");
    expect(phase.runId).toBe(page.run_id);
    expect(waiting).toMatchObject({ phase: "waiting_for_compute", workersOnline: 0, autoscaling: false });
    expect(starting.gpu).toEqual({ name: "NVIDIA H100 80GB HBM3", memoryGb: 79.6 });
    const interrupted = events.find((e) => e.type === "attempt" && e.event === "interrupted");
    expect(interrupted).toMatchObject({ reason: "compute_reclaimed", resumeStep: 2, maxAttempts: 3 });
    const done = events.at(-1);
    expect(done?.type === "completed" && done.run.status).toBe("completed");
  });

  it("runs wait() on the event stream: onEvent, onMetric and onStatus on phase changes", async () => {
    const server = new FakeServer()
      .on("GET", `${RUN}/events`, sse(blocks))
      .on("GET", RUN, json(queuedRun))
      .on("GET", `/v1/artifacts/${encodeURIComponent(finalRun.artifact_id)}`, json(wire("artifact.json")));
    const { grad } = makeGrad(server);
    const types: string[] = [];
    const steps: number[] = [];
    const statuses: Array<[RunStatus, string | null]> = [];
    const done = await grad.runs.wait(page.run_id, {
      onEvent: (e) => void types.push(e.type),
      onMetric: (m) => void steps.push(m.step),
      onStatus: (status, run) => void statuses.push([status, run.phase]),
    });
    expect(done.status).toBe("completed");
    expect(done.lastInterruption?.reason).toBe("compute_reclaimed");
    expect(types).toHaveLength(page.data.length);
    expect(steps).toEqual([1, 2, 3]);
    expect(statuses[0]).toEqual(["queued", "queued"]);
    expect(statuses).toContainEqual(["queued", "waiting_for_compute"]);
    expect(statuses).toContainEqual(["running", "training"]);
    expect(statuses.at(-1)).toEqual(["completed", null]);
  });

  it("tracks phase and interruptions on the Run while streaming", async () => {
    const cut = page.data.findIndex((e) => e.type === "phase" && (e as unknown as { phase: string }).phase === "queued" && e.seq > 1);
    const server = new FakeServer()
      .on("GET", `${RUN}/events`, sse(blocks.slice(0, cut + 1)), sse(blocks.slice(cut + 1)))
      .on("GET", RUN, json({ ...queuedRun, status: "running", phase: "training" }));
    const { grad } = makeGrad(server);
    const run = await grad.runs.get(page.run_id);
    const stream = run.events({ follow: true });
    for (let i = 0; i <= cut; i += 1) await stream.next();
    expect(run.status).toBe("queued");
    expect(run.phase).toBe("queued");
    expect(run.lastInterruption).toMatchObject({ attempt: 1, reason: "compute_reclaimed", step: 2, resumeStep: 2 });
    for await (const _ of stream) void _;
    expect(run.status).toBe("completed");
  });

  it("pages JSON events without follow, ending with completed", async () => {
    const half = Math.floor(page.data.length / 2);
    const server = new FakeServer().on("GET", `${RUN}/events`, (call) =>
      call.url.searchParams.get("cursor")
        ? json({ ...page, data: page.data.slice(half), next_cursor: null })
        : json({ ...page, data: page.data.slice(0, half), next_cursor: "c2" }),
    );
    const { grad } = makeGrad(server);
    const run = await grad.runs.get(page.run_id).catch(() => undefined);
    void run;
    const all: RunEvent[] = [];
    for await (const ev of grad.runs.events(page.run_id, { limit: half })) all.push(ev);
    expect(all).toHaveLength(page.data.length);
    expect(all.at(-1)?.type).toBe("completed");
    const calls = server.callsTo("GET", `${RUN}/events`);
    expect(calls[0]?.url.search).toBe(`?limit=${half}`);
    expect(calls[1]?.url.searchParams.get("cursor")).toBe("c2");

    const failing = new FakeServer().on("GET", `${RUN}/events`, problemFixture("not-found"));
    const err = await makeGrad(failing).grad.runs.events(page.run_id, { follow: true }).next().catch((x: unknown) => x);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("ignores unknown SSE event names", async () => {
    const server = new FakeServer().on("GET", `${RUN}/events`, sse(["event: future\ndata: {}", ...blocks.slice(-1)]));
    const { grad } = makeGrad(server);
    const seen: string[] = [];
    for await (const ev of grad.runs.events(page.run_id, { follow: true })) seen.push(ev.type);
    expect(seen).toEqual(["completed"]);
  });
});
