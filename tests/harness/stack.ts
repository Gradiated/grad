/**
 * Boots a complete local grad stack for SDK, CLI and cross-language E2E tests:
 * a fake OpenAI-compatible inference/judge server (judges score 0.9), optionally a fake Gradiated
 * Cloud API, the real grad-server, its eval worker (`grad-server worker --kinds
 * eval`), and optionally a real trainer worker.
 *
 * Prints one JSON line to stdout once everything is ready, then runs until
 * SIGTERM/SIGINT or stdin closes, and tears every child process down.
 *
 *   pnpm -C server/api exec tsx ../../tests/harness/stack.ts [--cloud]
 *     [--auth none|api_key] [--worker none|reference|torch] [--online]
 *     [--database-url postgres://...] [--replicas N]
 *     [--drop-worker-ack-every N]
 *
 * Without --database-url it starts a throwaway `gradr5-pg-<pid>` Postgres
 * container on a random loopback port, and it always starts a `gradr8-s3-<pid>`
 * SeaweedFS (the S3 store `grad local up` runs; the server and workers use
 * its presigned URLs). Both are removed on exit (stale ones older than 2 h,
 * left by a SIGKILL, are reaped on the next start).
 *
 * Output: {"base_url","api_key","trainer_key","inference_url","cloud_url",
 *          "workspace_id","mode","worker","model_paths","fault_url",
 *          "worker_url","replicas":[{"url","pid"}],"eval_worker_pid",
 *          "langfuse_url","langfuse_secret","ui_url","s3","tiny_lora",
 *          "tiny_lora_invalid"}
 * `eval_worker_pid` is the eval worker, so a chaos test can kill -9 it.
 * `--cloud` runs grad in AUTH_MODE/BILLING_MODE=cloud against
 * server/api/test/fixtures/fake-cloud-api.ts at `cloud_url` (auth view in a
 * schema of the stack's Postgres, JWKS, billing, prices, the gateway in front
 * of the fake inference server). Its `/_control/*` routes mint console and
 * service JWTs, add keys and set balances; `internal_url` takes the service
 * JWTs (workspace state, artifact pins).
 * `ui_url` is the web UI (null in --cloud mode or until `pnpm -C server/ui
 * build` has run); open `<ui_url>#key=<api_key>` to get the sign-in form filled in.
 * `langfuse_url` is tests/fixtures/fake-langfuse.ts (drive it via its
 * /_control/ routes); store `langfuse_secret` as a grad secret to sync it.
 * Workers reach it through GRAD_SOURCES_EGRESS_ALLOW=127.0.0.1/32 with the
 * settle delay off.
 * `fault_url` is the same server behind tests/harness/fault-proxy.ts, which
 * drops the response to the first attempt of every keyed POST (after the
 * server committed it) so live tests can prove Idempotency-Key replays.
 * `--replicas N` starts N grad-server processes on the same database and
 * bucket (one PID each, so a chaos test can kill -9 one); `worker_url` is a
 * fault proxy over all of them that fails over from a dead replica and, with
 * `--drop-worker-ack-every N`, cuts every N-th worker POST's response after
 * the server committed it. Workers started here use `worker_url`.
 * Trainer Python: $GRAD_TRAINER_PYTHON (default python3). Torch workers build
 * the tiny test models from server/trainer/tests/fixtures/tiny_models.py, and
 * `tiny_lora` / `tiny_lora_invalid` (PEFT LoRA directories for test/tiny-qwen3;
 * the invalid one names another base) for live `artifacts upload` tests.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  startDockerPostgres,
  type DockerPostgres,
} from "../../server/api/test/fixtures/docker-postgres.js";
import {
  startDockerSeaweedfs,
  type DockerSeaweedfs,
} from "../../server/api/test/fixtures/docker-seaweedfs.js";
import {
  startFakeCloudApi,
  type FakeCloudApi,
} from "../../server/api/test/fixtures/fake-cloud-api.js";
import { startFakeOpenAI } from "../../server/api/test/fixtures/fake-openai.js";
import { startFakeLangfuse } from "../fixtures/fake-langfuse.js";
import { startFaultProxy, type FaultProxy } from "./fault-proxy.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const apiDir = join(repo, "server", "api");
const trainerDir = join(repo, "server", "trainer");

export const API_KEY = "grad_e2e_admin_key";
export const TRAINER_KEY = "grad_e2e_trainer_key";
/** Mints lease tokens on the first replica's internal port (GRAD_WORKER_AUTH=static,lease). */
export const ORCHESTRATOR_KEY = "grad_e2e_orchestrator_key";
export const WORKSPACE_ID = "ws_e2e";
/** The frontier judges the docs use, priced like an operator would. */
const JUDGES = [
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-opus-5-5",
  "openai/gpt-6.1-sol",
];

export const TINY_MODELS = [
  {
    id: "test/tiny-qwen3",
    hf_repo: null,
    family: "llm",
    adapters: ["lora", "prefix_kv"],
    default_for: [],
    price_per_million_tokens_usd: 1,
    max_context_tokens: 2048,
    // The 512-token dev tokenizer: about 1.5 characters a token on chat text.
    chars_per_token: 1.5,
    template_revision: "qwen3@3",
    calibrated_lrs: {
      sft: 1e-3,
      dpo: 1e-4,
      router: 1e-3,
      decision: 1e-3,
      cartridge: 1e-2,
      distill: 1e-3,
      reward: 1e-3,
    },
  },
  {
    id: "test/tiny-qwen3-teacher",
    hf_repo: null,
    family: "llm",
    adapters: ["lora", "prefix_kv"],
    default_for: [],
    price_per_million_tokens_usd: 2,
    max_context_tokens: 2048,
    // The 512-token dev tokenizer: about 1.5 characters a token on chat text.
    chars_per_token: 1.5,
    template_revision: "qwen3@3",
    calibrated_lrs: { sft: 1e-3 },
  },
  {
    id: "test/tiny-bert",
    hf_repo: null,
    family: "encoder",
    adapters: ["encoder_full"],
    default_for: [],
    price_per_million_tokens_usd: 0.5,
    max_context_tokens: 512,
    template_revision: "bge@1",
    calibrated_lrs: { embedding: 1e-4 },
  },
];

/** The fake Cloud price list: the tiny models' training and the judges' inference, in nano-USD per million tokens. */
const CLOUD_PRICES: Record<string, number> = Object.fromEntries([
  ...TINY_MODELS.flatMap((m) => [
    [`train:${m.id}`, m.price_per_million_tokens_usd * 1e9],
    [`inference:${m.id}`, m.price_per_million_tokens_usd * 1e9],
  ]),
  ...JUDGES.map((id) => [`inference:${id}`, 3e9]),
]);

const { values: args } = parseArgs({
  options: {
    cloud: { type: "boolean", default: false },
    auth: { type: "string", default: "api_key" },
    worker: { type: "string", default: "none" },
    "database-url": { type: "string" },
    replicas: { type: "string", default: "1" },
    "drop-worker-ack-every": { type: "string", default: "0" },
    // Let the worker download Hugging Face datasets (offline by default).
    online: { type: "boolean", default: false },
  },
});

const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolvePort(port));
    });
  });

const waitReady = async (url: string, child: ChildProcess) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`grad-server exited with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${url}/health/ready`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("grad-server did not become ready within 60s");
};

/** The tiny models' GRAD_MODEL_PATHS and two PEFT LoRAs for them (valid, and naming the wrong base). */
const tinyModels = (
  python: string,
): { paths: Record<string, string>; lora: string; lora_invalid: string } => {
  const script = [
    "import json, os, sys, tempfile",
    "from pathlib import Path",
    "sys.path.insert(0, 'tests')",
    "from fixtures import tiny_models as t",
    "t.ensure_tiny_models()",
    "t.atexit.unregister(t.shutil.rmtree)",
    "loras = t.build_tiny_loras(Path(tempfile.mkdtemp(prefix='grad-tiny-lora-')))",
    "print(json.dumps({'paths': json.loads(os.environ['GRAD_MODEL_PATHS']), **loras}))",
  ].join("\n");
  const out = spawnSync(python, ["-c", script], {
    cwd: trainerDir,
    env: { ...process.env, PYTHONPATH: "." },
    encoding: "utf8",
  });
  if (out.status !== 0) {
    throw new Error(`building tiny models failed:\n${out.stderr}`);
  }
  const lines = out.stdout.trim().split("\n");

  return JSON.parse(lines[lines.length - 1] ?? "{}") as ReturnType<
    typeof tinyModels
  >;
};

const main = async () => {
  const children: ChildProcess[] = [];
  const scratch = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), "grad-stack-"),
  );
  const inference = await startFakeOpenAI({ judgeScore: 0.9 });
  const langfuse = await startFakeLangfuse();
  let cloud: FakeCloudApi | undefined;
  let modelPaths: Record<string, string> = {};
  let tinyLoras: { lora: string; lora_invalid: string } | null = null;
  let faultProxy: FaultProxy | undefined;
  let workerProxy: FaultProxy | undefined;
  let postgres: Promise<DockerPostgres> | undefined;
  let s3: Promise<DockerSeaweedfs> | undefined;

  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of children.reverse()) child.kill("SIGTERM");
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((done) => {
            if (child.exitCode !== null) return done();
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              done();
            }, 10_000);
            child.once("exit", () => {
              clearTimeout(timer);
              done();
            });
          }),
      ),
    );
    await faultProxy?.close();
    await workerProxy?.close();
    await inference.close();
    await langfuse.close();
    await cloud?.close();
    await postgres?.then(
      (pg) => pg.stop(),
      () => undefined,
    );
    await s3?.then(
      (store) => store.stop(),
      () => undefined,
    );
    rmSync(scratch, { recursive: true, force: true });
    for (const dir of new Set([
      ...Object.values(modelPaths).map((p) => dirname(p)),
      ...(tinyLoras ? [dirname(tinyLoras.lora)] : []),
    ])) {
      rmSync(dir, { recursive: true, force: true });
    }
    process.exit(code);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  process.stdin.on("end", () => void stop());
  process.stdin.resume();

  try {
    s3 = startDockerSeaweedfs();
    s3.catch(() => undefined); // awaited below, after Postgres
    let databaseUrl = args["database-url"];
    if (!databaseUrl) {
      postgres = startDockerPostgres();
      databaseUrl = (await postgres).url;
    }
    const bucket = (await s3).target;
    if (args.cloud) {
      // The product side: the auth view (in a schema of the stack's
      // Postgres), JWKS, billing and prices, and the gateway in front of
      // the fake inference server.
      cloud = await startFakeCloudApi({
        serviceToken: "svc_e2e_token",
        databaseUrl,
        gatewayUpstream: inference.baseUrl,
        prices: CLOUD_PRICES,
      });
      await cloud.addKey(API_KEY, { workspace_id: WORKSPACE_ID, role: "admin" });
    }
    if (stopping) return;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOST: "127.0.0.1",
      S3_BUCKET: bucket.bucket,
      S3_ENDPOINT: bucket.endpoint,
      S3_REGION: bucket.region,
      AWS_ACCESS_KEY_ID: bucket.accessKeyId,
      AWS_SECRET_ACCESS_KEY: bucket.secretAccessKey,
      GRAD_EXTRA_MODELS_JSON: JSON.stringify(TINY_MODELS),
      // The frontier judges the docs use, priced like an operator would.
      GRAD_JUDGE_MODELS_JSON: JSON.stringify(
        JUDGES.map((id) => ({ id, price_per_million_tokens_usd: 3 })),
      ),
      // The API only checks an endpoint is set; the eval worker calls it.
      GRAD_INFERENCE_BASE_URL: `${inference.baseUrl}`,
      TRAINER_API_KEY: TRAINER_KEY,
      GRAD_WORKER_AUTH: "static,lease",
      GRAD_ORCHESTRATOR_KEYS_JSON: JSON.stringify([
        {
          label: "e2e",
          sha256: createHash("sha256").update(ORCHESTRATOR_KEY).digest("hex"),
          kinds: ["train", "import"],
        },
      ]),
      MAINTENANCE_INTERVAL_MS: "500",
      GRAD_SECRETS_KEY: randomBytes(32).toString("base64"),
      // Live tests sync a source several times in a row.
      SOURCE_SYNC_INTERVAL_SECONDS: "0",
      DEFAULT_WORKSPACE_ID: WORKSPACE_ID,
      DATABASE_URL: databaseUrl,
    };
    if (cloud) {
      // Evals go to the gateway, which bills them (no GRAD_INFERENCE_BASE_URL).
      delete env.GRAD_INFERENCE_BASE_URL;
      Object.assign(env, {
        AUTH_MODE: "cloud",
        BILLING_MODE: "cloud",
        GRAD_CLOUD_AUTH_DATABASE_URL: cloud.authDatabaseUrl as string,
        GRAD_CLOUD_JWKS_URL: cloud.jwksUrl,
        GRAD_CLOUD_JWT_ISSUER: cloud.issuer,
        GRAD_CLOUD_BILLING_URL: cloud.billingUrl,
        GRAD_CLOUD_PRICES_URL: cloud.pricesUrl,
        GRAD_CLOUD_GATEWAY_URL: cloud.gatewayUrl,
        CLOUD_INTERNAL_API_URL: cloud.url,
        CLOUD_SERVICE_TOKEN: cloud.serviceToken,
        // The fake serves traces:pull; the product doesn't yet.
        GRAD_CLOUD_TRACES_ENABLED: "true",
        GRAD_WORKSPACE_PURGE_DELAY_SECONDS: "0",
      });
    } else {
      Object.assign(env, {
        AUTH_MODE: args.auth,
        ADMIN_API_KEY_HASH: createHash("sha256").update(API_KEY).digest("hex"),
      });
    }

    // `node --import tsx` keeps each replica one process (one PID to kill).
    const replicas: Array<{ url: string; pid: number }> = [];
    let internalUrl = "";
    for (let i = 0; i < Math.max(1, Number(args.replicas)); i += 1) {
      const port = await freePort();
      let internalPort = await freePort();
      while (internalPort === port) internalPort = await freePort();
      internalUrl ||= `http://127.0.0.1:${internalPort}`;
      const server = spawn(
        process.execPath,
        ["--import", "tsx", "src/main.ts"],
        {
          cwd: apiDir,
          env: {
            ...env,
            PORT: String(port),
            INTERNAL_PORT: String(internalPort),
          },
          stdio: ["ignore", 2, 2],
        },
      );
      children.push(server);
      const url = `http://127.0.0.1:${port}`;
      await waitReady(url, server);
      replicas.push({ url, pid: server.pid as number });
    }
    const baseUrl = (replicas[0] as { url: string }).url;
    faultProxy = await startFaultProxy(baseUrl);
    const dropEvery = Number(args["drop-worker-ack-every"]);
    if (replicas.length > 1 || dropEvery > 0) {
      workerProxy = await startFaultProxy(
        replicas.map((r) => r.url),
        { dropWorkerAckEvery: dropEvery },
      );
    }
    const workerUrl = workerProxy?.url ?? baseUrl;

    // The eval worker (`grad-server worker --kinds eval`): evals,
    // dataset.score(), router labelling and checkpoint evals.
    const evalWorker = spawn(
      process.execPath,
      ["--import", "tsx", "src/main.ts", "worker", "--kinds", "eval"],
      {
        cwd: apiDir,
        env: {
          ...(process.env as Record<string, string>),
          GRAD_SERVER_URL: workerUrl,
          TRAINER_API_KEY: TRAINER_KEY,
          GRAD_WORKER_ID: "harness-eval-worker",
          GRAD_POLL_INTERVAL_S: "0.2",
          // Short leases, so a chaos test that kills it resumes quickly.
          GRAD_LEASE_SECONDS: "30",
          ...(cloud
            ? {
                GRAD_CLOUD_GATEWAY_URL: cloud.gatewayUrl,
                GRAD_CLOUD_GATEWAY_TOKEN: cloud.gatewayToken,
              }
            : {
                GRAD_INFERENCE_BASE_URL: `${inference.baseUrl}`,
                GRAD_INFERENCE_API_KEY: "sk-fake-inference",
              }),
        },
        stdio: ["ignore", 2, 2],
      },
    );
    children.push(evalWorker);

    const python = process.env.GRAD_TRAINER_PYTHON ?? "python3";
    if (args.worker !== "none") {
      if (args.worker === "torch") {
        const tiny = tinyModels(python);
        modelPaths = tiny.paths;
        tinyLoras = { lora: tiny.lora, lora_invalid: tiny.lora_invalid };
      }
      const worker = spawn(python, ["-m", "grad_trainer.worker"], {
        cwd: trainerDir,
        env: {
          ...process.env,
          PYTHONPATH: ".",
          GRAD_SERVER_URL: workerUrl,
          TRAINER_API_KEY: TRAINER_KEY,
          GRAD_POLL_INTERVAL_S: "0.2",
          GRAD_WORKDIR: join(scratch, "worker"),
          GRAD_TRAINER_BACKEND:
            args.worker === "reference" ? "reference" : "torch",
          GRAD_MODEL_PATHS: JSON.stringify(modelPaths),
          ...(args.online ? {} : { GRAD_OFFLINE: "1", HF_HUB_OFFLINE: "1" }),
          GRAD_SOURCES_EGRESS_ALLOW: "127.0.0.1/32",
          GRAD_SOURCES_SETTLE_SECONDS: "0",
        },
        stdio: ["ignore", 2, 2],
      });
      children.push(worker);
    }

    process.stdout.write(
      `${JSON.stringify({
        base_url: baseUrl,
        api_key: API_KEY,
        trainer_key: TRAINER_KEY,
        internal_url: internalUrl,
        orchestrator_key: ORCHESTRATOR_KEY,
        inference_url: inference.baseUrl,
        cloud_url: cloud?.url ?? null,
        workspace_id: WORKSPACE_ID,
        mode: cloud ? "cloud" : "self_hosted",
        worker: args.worker,
        model_paths: modelPaths,
        // --worker torch: PEFT LoRA directories for test/tiny-qwen3 (artifacts.upload).
        tiny_lora: tinyLoras?.lora ?? null,
        tiny_lora_invalid: tinyLoras?.lora_invalid ?? null,
        fault_url: faultProxy.url,
        worker_url: workerUrl,
        replicas,
        eval_worker_pid: evalWorker.pid,
        langfuse_url: langfuse.url,
        langfuse_secret: langfuse.secret,
        // The stack's SeaweedFS bucket (scripts/load/sources.py counts its objects).
        s3: bucket,
        // grad-server serves server/ui/dist when it is built (pnpm -C server/ui build).
        ui_url:
          !cloud && existsSync(join(repo, "server", "ui", "dist", "index.html"))
            ? `${baseUrl}/`
            : null,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `stack failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await stop(1);
  }
};

void main();
