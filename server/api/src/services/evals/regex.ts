import { Worker } from "node:worker_threads";

import type { RegexEvaluator, RegexOutcome } from "./types.js";

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  let matched = false;
  let error = null;
  try {
    matched = new RegExp(msg.pattern, msg.flags).test(msg.input);
  } catch (e) {
    error = String((e && e.message) || e);
  }
  parentPort.postMessage({ id: msg.id, matched, error });
});
`;

interface PendingRequest {
  id: number;
  pattern: string;
  flags: string;
  input: string;
  resolve: (outcome: RegexOutcome) => void;
  reject: (error: Error) => void;
}

interface WorkerHandle {
  worker: Worker;
  online: Promise<void>;
}

/**
 * Runs regex rubric items in a worker thread with a hard per-call timeout.
 * A catastrophic (ReDoS) pattern is interrupted by terminating the worker,
 * so the API event loop never executes untrusted patterns.
 */
export const createRegexEvaluator = (
  options: { timeoutMs?: number } = {},
): RegexEvaluator => {
  const timeoutMs = options.timeoutMs ?? 100;
  const queue: PendingRequest[] = [];
  let handle: WorkerHandle | null = null;
  let busy = false;
  let closed = false;
  let nextId = 1;

  const spawn = (): WorkerHandle => {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.unref();
    const online = new Promise<void>((resolve) =>
      worker.once("online", resolve),
    );

    return { worker, online };
  };

  const pump = async (): Promise<void> => {
    if (busy || closed) return;
    const request = queue.shift();
    if (!request) return;
    busy = true;

    handle ??= spawn();
    const current = handle;
    await current.online;

    const outcome = await new Promise<RegexOutcome | Error>((resolve) => {
      const onMessage = (msg: {
        id: number;
        matched: boolean;
        error: string | null;
      }) => {
        if (msg.id !== request.id) return;
        cleanup();
        resolve(
          msg.error === null ? { matched: msg.matched } : new Error(msg.error),
        );
      };
      const onError = (error: Error) => {
        cleanup();
        handle = null;
        resolve(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        handle = null;
        void current.worker.terminate();
        resolve({ timedOut: true });
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        current.worker.off("message", onMessage);
        current.worker.off("error", onError);
      };

      current.worker.on("message", onMessage);
      current.worker.on("error", onError);
      current.worker.postMessage({
        id: request.id,
        pattern: request.pattern,
        flags: request.flags,
        input: request.input,
      });
    });

    busy = false;
    if (outcome instanceof Error) request.reject(outcome);
    else request.resolve(outcome);
    void pump();
  };

  return {
    test: (pattern, flags, input) => {
      if (closed)
        return Promise.reject(new Error("Regex evaluator is closed."));

      return new Promise<RegexOutcome>((resolve, reject) => {
        queue.push({ id: nextId++, pattern, flags, input, resolve, reject });
        void pump();
      });
    },
    close: async () => {
      closed = true;
      for (const pending of queue.splice(0)) {
        pending.reject(new Error("Regex evaluator is closed."));
      }
      if (handle) await handle.worker.terminate();
      handle = null;
    },
  };
};
