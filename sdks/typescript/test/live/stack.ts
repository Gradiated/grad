/**
 * Starts tests/harness/stack.ts (the shared live stack) for the live tests.
 * They skip cleanly when server/api/node_modules is missing (run
 * `pnpm -C server/api install --frozen-lockfile`) or GRAD_SKIP_LIVE=1.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRoot } from "../helpers.js";

const apiDir = path.join(repoRoot, "server", "api");
const tsx = path.join(apiDir, "node_modules", ".bin", "tsx");
const harness = path.join(repoRoot, "tests", "harness", "stack.ts");

export interface StackInfo {
  base_url: string;
  api_key: string;
  trainer_key: string;
  inference_url: string;
  cloud_url: string | null;
  workspace_id: string;
  mode: "cloud" | "self_hosted";
  worker: string;
  /** The server behind a proxy that drops the first response of every keyed POST. */
  fault_url: string;
  /** --worker torch: PEFT LoRA directories for test/tiny-qwen3 (valid, and naming another base). */
  tiny_lora: string | null;
  tiny_lora_invalid: string | null;
}

/** A Python with torch, transformers and peft for `--worker torch`, if configured. */
export const torchPython = (): string | undefined => {
  const python = process.env.GRAD_TRAINER_PYTHON;
  if (!python || !existsSync(python)) return undefined;
  const probe = spawnSync(python, ["-c", "import torch, transformers, peft"], { stdio: "ignore", timeout: 120_000 });
  return probe.status === 0 ? python : undefined;
};

/** Why live tests cannot run here, or undefined. */
export const liveSkipReason = (worker = "none"): string | undefined => {
  if (process.env.GRAD_SKIP_LIVE === "1") return "GRAD_SKIP_LIVE=1";
  if (!existsSync(tsx)) return `${tsx} missing (run \`pnpm -C server/api install --frozen-lockfile\`)`;
  if (!existsSync(harness)) return `${harness} missing`;
  if (worker === "torch" && !torchPython()) return "GRAD_TRAINER_PYTHON (a Python with torch, transformers and peft) is not set";
  return undefined;
};

export class Stack {
  private constructor(
    readonly info: StackInfo,
    private readonly child: ChildProcess,
    private readonly log: () => string,
  ) {}

  static async start(options: { cloud?: boolean; worker?: "none" | "reference" | "torch"; timeoutMs?: number } = {}): Promise<Stack> {
    const args = [harness, "--worker", options.worker ?? "none", "--auth", "api_key", ...(options.cloud ? ["--cloud"] : [])];
    const child = spawn(tsx, args, { cwd: apiDir, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      // Keep only the tail: the harness logs every request.
      stderr = (stderr + chunk.toString("utf8")).slice(-20_000);
    });
    const info = await new Promise<StackInfo>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`live stack did not start in time:\n${stderr}`)), options.timeoutMs ?? 300_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        const nl = stdout.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(stdout.slice(0, nl)) as StackInfo);
          } catch (error) {
            reject(error);
          }
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`live stack exited with ${code}:\n${stderr}`));
      });
    }).catch(async (error: unknown) => {
      child.kill("SIGKILL");
      throw error;
    });
    return new Stack(info, child, () => stderr);
  }

  get baseURL(): string {
    return this.info.base_url;
  }

  get apiKey(): string {
    return this.info.api_key;
  }

  get tinyLora(): { valid: string; invalid: string } {
    if (!this.info.tiny_lora || !this.info.tiny_lora_invalid) throw new Error("tiny LoRAs need --worker torch");
    return { valid: this.info.tiny_lora, invalid: this.info.tiny_lora_invalid };
  }

  logTail(): string {
    return this.log();
  }

  /** Closing stdin makes the harness tear down its children; SIGKILL our own child if it lingers. */
  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 30_000);
    const hard = setTimeout(() => this.child.kill("SIGKILL"), 45_000);
    await exited;
    clearTimeout(timer);
    clearTimeout(hard);
  }
}

/** A scratch directory with its own HOME/XDG config, removed by `cleanup`. */
export const scratchHome = (tag: string): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), `grad-ts-live-${tag}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};
