/**
 * SSE fan-out load test against one grad-server replica (tests/harness/stack.ts).
 *
 *   pnpm -C server/api exec tsx ../../tests/harness/sse-load.ts
 *     [--streams 1000] [--jobs 50] [--seconds 30] [--baseline-seconds 10]
 *     [--path events|metrics]
 *
 * Boots the stack (no worker), creates `--jobs` runs and claims them with a
 * fake worker, mints one read key per job (the per-key stream cap is 20), and
 * opens `--streams` SSE streams spread evenly over the jobs. Each fake job then
 * posts one metric a second. Phase 1 (`--baseline-seconds`) runs the writers
 * with no streams open; phase 2 (`--seconds`) with every stream open.
 *
 * Prints one JSON line: API Postgres queries/s (the server's
 * grad_db_query_duration_seconds_count, so it counts only this replica's
 * queries) per phase, API CPU (cores) and RSS, write -> client latency
 * p50/p95/p99 (metric `timestamp` set when the progress POST is sent, to
 * receipt; `write_rtt_ms` and `write_server_ms` are that POST's own round
 * trip and mean server time), and events lost or duplicated per stream.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, "../../server/api");

const { values: args } = parseArgs({
  options: {
    streams: { type: "string", default: "1000" },
    jobs: { type: "string", default: "50" },
    seconds: { type: "string", default: "30" },
    "baseline-seconds": { type: "string", default: "10" },
    path: { type: "string", default: "events" },
  },
});
const STREAMS = Number(args.streams);
const JOBS = Number(args.jobs);
const SECONDS = Number(args.seconds);
const BASELINE = Number(args["baseline-seconds"]);
const PATH = args.path === "metrics" ? "metrics" : "events";

interface Stack {
  base_url: string;
  api_key: string;
  trainer_key: string;
  replicas: Array<{ url: string; pid: number }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bootStack = async () => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "../../tests/harness/stack.ts", "--worker", "none"],
    { cwd: apiDir, stdio: ["pipe", "pipe", "inherit"] },
  );
  const line = await new Promise<string>((ok, fail) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once("line", ok);
    child.once("exit", (code) => fail(new Error(`stack exited ${code}`)));
  });

  return { stack: JSON.parse(line) as Stack, child };
};

const api = async <T = Record<string, unknown>>(
  stack: Stack,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> => {
  const res = await fetch(`${stack.base_url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${path} ${res.status}: ${text}`);

  return (text ? JSON.parse(text) : {}) as T;
};

/** Sums a /metrics series over every label set whose labels contain `labels`. */
const series = (text: string, name: string, labels = ""): number =>
  text
    .split("\n")
    .filter(
      (l) =>
        (l.startsWith(`${name} `) || l.startsWith(`${name}{`)) &&
        l.includes(labels),
    )
    .reduce((n, l) => n + Number(l.slice(l.lastIndexOf(" ") + 1)), 0);

const PROGRESS = 'route="/v1/trainer-jobs/:id/progress"';
const scrape = async (stack: Stack) => {
  const text = await (await fetch(`${stack.base_url}/metrics`)).text();

  return {
    queries: series(text, "grad_db_query_duration_seconds_count"),
    progressCount: series(
      text,
      "grad_http_request_duration_seconds_count",
      PROGRESS,
    ),
    progressSum: series(
      text,
      "grad_http_request_duration_seconds_sum",
      PROGRESS,
    ),
  };
};

const TICKS = 100; // /proc/<pid>/stat clock ticks per second (Linux USER_HZ)
const cpuSeconds = (pid: number): number => {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8")
    .split(") ")[1]!
    .split(" ");

  return (Number(fields[11]) + Number(fields[12])) / TICKS;
};
const rssMb = (pid: number): number => {
  const match = /VmRSS:\s+(\d+) kB/.exec(
    readFileSync(`/proc/${pid}/status`, "utf8"),
  );

  return match ? Math.round(Number(match[1]) / 1024) : Number.NaN;
};

interface StreamStats {
  job: number;
  seqs: number[];
  latencies: number[];
  opened: boolean;
  error: string | null;
}

const openStream = (
  stack: Stack,
  runId: string,
  key: string,
  stats: StreamStats,
  measuring: () => boolean,
  signal: AbortSignal,
) =>
  (async () => {
    try {
      const res = await fetch(`${stack.base_url}/v1/runs/${runId}/${PATH}`, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "text/event-stream",
        },
        signal,
      });
      if (res.status !== 200) {
        stats.error = `${res.status} ${await res.text()}`;
        return;
      }
      stats.opened = true;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event !== "metric" || !data) continue;
          const parsed = JSON.parse(data) as {
            seq: number;
            metric?: { timestamp: string; seq: number };
            timestamp: string;
          };
          const point = parsed.metric ?? parsed;
          stats.seqs.push(point.seq);
          if (measuring()) {
            stats.latencies.push(Date.now() - Date.parse(point.timestamp));
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) stats.error = String(error);
    }
  })();

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0
    ? null
    : sorted[
        Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
      ];

const main = async () => {
  const { stack, child } = await bootStack();
  const pid = (stack.replicas[0] as { pid: number }).pid;
  const admin = stack.api_key;
  try {
    await api(stack, "/v1/datasets/load/records", admin, {
      records: Array.from({ length: 20 }, (_, i) => ({
        messages: [
          { role: "user", content: `q ${i}?` },
          { role: "assistant", content: `answer ${i}` },
        ],
      })),
    });
    const runs: string[] = [];
    const keys: string[] = [];
    for (let i = 0; i < JOBS; i += 1) {
      const run = await api<{ id: string }>(stack, "/v1/runs", admin, {
        dataset: "load",
        name: `load-${i}`,
        recipe: { kind: "sft", model: "test/tiny-qwen3", batch_size: 4 },
      });
      runs.push(run.id);
      const key = await api<{ secret: string }>(stack, "/v1/keys", admin, {
        name: `load-${i}`,
        scopes: ["runs:read"],
      });
      keys.push(key.secret);
    }
    const jobs: Array<{ id: string; attempt: number; worker: string }> = [];
    for (let i = 0; i < JOBS; i += 1) {
      const worker = `load-worker-${i}`;
      const { job } = await api<{
        job: { id: string; attempt: number } | null;
      }>(stack, "/v1/trainer-jobs/claim", stack.trainer_key, {
        worker_id: worker,
        lease_seconds: 600,
        kinds: ["train"],
      });
      if (!job) throw new Error(`claim ${i} returned no job`);
      jobs.push({ ...job, worker });
    }

    // Each job writes one metric a second, the jobs evenly staggered.
    const steps = jobs.map(() => 0);
    const writeRtts: number[] = [];
    let writes = 0;
    let writing = true;
    let measuring = false;
    const writer = Promise.all(
      jobs.map(async (job, i) => {
        await sleep((i * 1000) / jobs.length);
        while (writing) {
          const tick = Date.now();
          steps[i] = (steps[i] ?? 0) + 1;
          await api(
            stack,
            `/v1/trainer-jobs/${job.id}/progress`,
            stack.trainer_key,
            {
              worker_id: job.worker,
              attempt: job.attempt,
              metric: {
                step: steps[i],
                loss: 1 / ((steps[i] ?? 0) + 1),
                tokens: (steps[i] ?? 0) * 10,
                timestamp: new Date(tick).toISOString(),
              },
            },
          );
          writes += 1;
          writeRtts.push(Date.now() - tick);
          await sleep(Math.max(0, 1000 - (Date.now() - tick)));
        }
      }),
    );

    const measureWindow = async (seconds: number) => {
      const m0 = await scrape(stack);
      const c0 = cpuSeconds(pid);
      const w0 = writes;
      const r0 = writeRtts.length;
      const t0 = Date.now();
      await sleep(seconds * 1000);
      const elapsed = (Date.now() - t0) / 1000;
      const m1 = await scrape(stack);
      const rtts = writeRtts.slice(r0).sort((a, b) => a - b);

      return {
        seconds: Math.round(elapsed),
        db_queries_per_s: Math.round((m1.queries - m0.queries - 1) / elapsed),
        writes_per_s: Math.round((writes - w0) / elapsed),
        api_cpu_cores: Number(((cpuSeconds(pid) - c0) / elapsed).toFixed(3)),
        api_rss_mb: rssMb(pid),
        // The progress POST: client round trip, and the server's own mean time.
        write_rtt_ms: { p50: percentile(rtts, 50), p95: percentile(rtts, 95) },
        write_server_ms: Math.round(
          ((m1.progressSum - m0.progressSum) /
            Math.max(1, m1.progressCount - m0.progressCount)) *
            1000,
        ),
      };
    };

    await sleep(2000);
    const baseline = await measureWindow(BASELINE);

    const abort = new AbortController();
    const stats: StreamStats[] = Array.from({ length: STREAMS }, (_, i) => ({
      job: i % JOBS,
      seqs: [],
      latencies: [],
      opened: false,
      error: null,
    }));
    const attachStart = Date.now();
    const done = stats.map((s) =>
      openStream(
        stack,
        runs[s.job] as string,
        keys[s.job] as string,
        s,
        () => measuring,
        abort.signal,
      ),
    );
    while (stats.some((s) => !s.opened && !s.error)) await sleep(50);
    const attachMs = Date.now() - attachStart;
    await sleep(3000);
    measuring = true;
    const firstSteps = steps.map((n) => n + 1);
    const loaded = await measureWindow(SECONDS);
    measuring = false;
    const lastSteps = [...steps];
    writing = false;
    await writer;
    await sleep(3000);
    abort.abort();
    await Promise.allSettled(done);

    // Every stream must hold each step its job wrote in the window, once.
    let lost = 0;
    let duplicated = 0;
    const seqSteps = new Map<number, number>();
    for (const job of jobs) {
      const page = await api<{ data: Array<{ seq: number; step: number }> }>(
        stack,
        `/v1/runs/${runs[jobs.indexOf(job)]}/metrics?limit=5000`,
        admin,
      );
      for (const p of page.data) seqSteps.set(p.seq, p.step);
    }
    for (const s of stats) {
      duplicated += s.seqs.length - new Set(s.seqs).size;
      const got = new Set(s.seqs.map((seq) => seqSteps.get(seq) ?? -1));
      for (let k = firstSteps[s.job] ?? 0; k <= (lastSteps[s.job] ?? 0); k += 1)
        if (!got.has(k)) lost += 1;
    }
    const latencies = stats.flatMap((s) => s.latencies).sort((a, b) => a - b);

    process.stdout.write(
      `${JSON.stringify({
        path: PATH,
        streams: STREAMS,
        jobs: JOBS,
        stream_errors: stats.filter((s) => s.error).length,
        first_error: stats.find((s) => s.error)?.error ?? null,
        attach_all_ms: attachMs,
        baseline,
        loaded,
        sse_queries_per_s: loaded.db_queries_per_s - baseline.db_queries_per_s,
        latency_ms: {
          samples: latencies.length,
          p50: percentile(latencies, 50),
          p95: percentile(latencies, 95),
          p99: percentile(latencies, 99),
          max: latencies.at(-1) ?? null,
        },
        lost,
        duplicated,
      })}\n`,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`sse-load failed: ${String(error)}\n`);
  process.exit(1);
});
