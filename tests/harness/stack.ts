/**
 * Boots a complete local grad stack for SDK, CLI and cross-language E2E tests:
 * a fake OpenAI-compatible inference/judge server, optionally a fake Gradiated
 * Cloud API, the real grad-server, and optionally a real trainer worker.
 *
 * Prints one JSON line to stdout once everything is ready, then runs until
 * SIGTERM/SIGINT or stdin closes, and tears every child process down.
 *
 *   pnpm -C server/api exec tsx ../../tests/harness/stack.ts [--cloud]
 *     [--auth none|api_key] [--worker none|reference|torch]
 *     [--database-url postgres://...]
 *
 * Output: {"base_url","api_key","trainer_key","inference_url","cloud_url",
 *          "workspace_id","mode","worker","model_paths"}
 * Trainer Python: $GRAD_TRAINER_PYTHON (default python3). Torch workers build
 * the tiny test models from server/trainer/tests/fixtures/tiny_models.py.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { startFakeCloudApi } from "../../server/api/test/fixtures/fake-cloud-api.js";
import { startFakeOpenAI } from "../../server/api/test/fixtures/fake-openai.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const apiDir = join(repo, "server", "api");
const trainerDir = join(repo, "server", "trainer");

export const API_KEY = "grad_e2e_admin_key";
export const TRAINER_KEY = "grad_e2e_trainer_key";
export const WORKSPACE_ID = "ws_e2e";

export const TINY_MODELS = [
  {
    id: "test/tiny-qwen3",
    hf_repo: null,
    family: "llm",
    adapters: ["lora", "prefix_kv"],
    default_for: [],
    price_per_million_tokens_usd: 1,
    max_context_tokens: 2048,
    template_revision: "qwen3@3",
    calibrated_lrs: { sft: 1e-3, dpo: 1e-4, router: 1e-3, cartridge: 1e-2 },
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

const { values: args } = parseArgs({
  options: {
    cloud: { type: "boolean", default: false },
    auth: { type: "string", default: "api_key" },
    worker: { type: "string", default: "none" },
    "database-url": { type: "string" },
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

const tinyModelPaths = (python: string): Record<string, string> => {
  const script = [
    "import json, os, sys",
    "sys.path.insert(0, 'tests')",
    "from fixtures import tiny_models as t",
    "t.ensure_tiny_models()",
    "t.atexit.unregister(t.shutil.rmtree)",
    "print(os.environ['GRAD_MODEL_PATHS'])",
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

  return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, string>;
};

const main = async () => {
  const children: ChildProcess[] = [];
  const scratch = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), "grad-stack-"),
  );
  const inference = await startFakeOpenAI();
  const cloud = args.cloud
    ? await startFakeCloudApi({ serviceToken: "svc_e2e_token" })
    : undefined;
  let modelPaths: Record<string, string> = {};

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
    await inference.close();
    await cloud?.close();
    rmSync(scratch, { recursive: true, force: true });
    for (const dir of new Set(
      Object.values(modelPaths).map((p) => dirname(p)),
    )) {
      rmSync(dir, { recursive: true, force: true });
    }
    process.exit(code);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  process.stdin.on("end", () => void stop());
  process.stdin.resume();

  try {
    if (cloud) {
      cloud.tokens.set(API_KEY, {
        workspace_id: WORKSPACE_ID,
        scopes: ["admin"],
      });
    }
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PORT: String(port),
      HOST: "127.0.0.1",
      STORAGE_DIR: join(scratch, "storage"),
      GRAD_EXTRA_MODELS_JSON: JSON.stringify(TINY_MODELS),
      INFERENCE_BASE_URL: `${inference.baseUrl}`,
      INFERENCE_API_KEY: "sk-fake-inference",
      TRAINER_API_KEY: TRAINER_KEY,
      MAINTENANCE_INTERVAL_MS: "500",
      DEFAULT_WORKSPACE_ID: WORKSPACE_ID,
    };
    if (args["database-url"]) env.DATABASE_URL = args["database-url"];
    if (cloud) {
      Object.assign(env, {
        AUTH_MODE: "cloud",
        BILLING_MODE: "cloud",
        DEPLOY_MODE: "cloud",
        CLOUD_INTERNAL_API_URL: cloud.url,
        CLOUD_SERVICE_TOKEN: cloud.serviceToken,
      });
    } else {
      Object.assign(env, {
        AUTH_MODE: args.auth,
        DEPLOY_MODE: "disabled",
        ADMIN_API_KEY_HASH: createHash("sha256").update(API_KEY).digest("hex"),
      });
    }

    const server = spawn(
      join(apiDir, "node_modules", ".bin", "tsx"),
      ["src/main.ts"],
      {
        cwd: apiDir,
        env,
        stdio: ["ignore", 2, 2],
      },
    );
    children.push(server);
    await waitReady(baseUrl, server);

    const python = process.env.GRAD_TRAINER_PYTHON ?? "python3";
    if (args.worker !== "none") {
      if (args.worker === "torch") modelPaths = tinyModelPaths(python);
      const worker = spawn(python, ["-m", "grad_trainer.worker"], {
        cwd: trainerDir,
        env: {
          ...process.env,
          PYTHONPATH: ".",
          GRAD_SERVER_URL: baseUrl,
          TRAINER_API_KEY: TRAINER_KEY,
          GRAD_POLL_INTERVAL_S: "0.2",
          GRAD_WORKDIR: join(scratch, "worker"),
          GRAD_TRAINER_BACKEND:
            args.worker === "reference" ? "reference" : "torch",
          GRAD_MODEL_PATHS: JSON.stringify(modelPaths),
          GRAD_OFFLINE: "1",
          HF_HUB_OFFLINE: "1",
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
        inference_url: inference.baseUrl,
        cloud_url: cloud?.url ?? null,
        workspace_id: WORKSPACE_ID,
        mode: cloud ? "cloud" : "self_hosted",
        worker: args.worker,
        model_paths: modelPaths,
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
