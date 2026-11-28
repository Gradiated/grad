// Playwright global setup: starts tests/harness/stack.ts (grad-server serving
// this package's dist/, Postgres, SeaweedFS, the fake inference server, the eval
// worker and the reference trainer worker) and tears it down afterwards.
// GRAD_E2E_BASE_URL + GRAD_E2E_API_KEY point the suite at a stack you started yourself.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../../..");
const apiDir = path.join(repo, "server", "api");

export default async (): Promise<() => Promise<void>> => {
  if (process.env.GRAD_E2E_BASE_URL) return async () => undefined;
  if (!existsSync(path.join(repo, "server", "ui", "dist", "index.html"))) throw new Error("build the UI first: pnpm -C server/ui exec vite build");

  const child = spawn(path.join(apiDir, "node_modules", ".bin", "tsx"), [path.join(repo, "tests", "harness", "stack.ts"), "--auth", "api_key", "--worker", "reference"], {
    cwd: apiDir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-20_000)));
  const info = await new Promise<{ base_url: string; api_key: string }>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`stack did not start:\n${stderr}`)), 240_000);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
      const nl = out.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(out.slice(0, nl)) as { base_url: string; api_key: string });
    });
    child.once("exit", (code) => reject(new Error(`stack exited with ${code}:\n${stderr}`)));
  });
  process.env.GRAD_E2E_BASE_URL = info.base_url;
  process.env.GRAD_E2E_API_KEY = info.api_key;

  return async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.stdin.end(); // closing stdin tears the stack (and its containers) down
    const kill = setTimeout(() => child.kill("SIGKILL"), 45_000);
    await exited;
    clearTimeout(kill);
  };
};
