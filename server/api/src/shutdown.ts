import type { Server } from "node:http";

import { log } from "./telemetry/log.js";

interface ShutdownSteps {
  /**
   * The HTTP listeners (the API, and the internal and metrics ones when
   * configured); each stops accepting at once, open streams get `graceMs`.
   */
  servers: ReadonlyArray<Pick<Server, "close" | "closeAllConnections">>;
  /** Makes /health/ready answer 503 from now on. */
  startDraining: () => void;
  /**
   * How long to keep serving after readiness fails, so load balancers and
   * Kubernetes endpoints stop routing here before the listener closes.
   */
  drainMs?: number;
  /** Background work that must hand its leases back (eval executor, maintenance). */
  stopBackground: () => Promise<void>;
  /** Pools and workers, closed last. */
  closeResources: () => Promise<void>;
  graceMs?: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SIGTERM: fail readiness and keep serving for `drainMs` (new requests still
 * arrive until the endpoint is removed), then stop background work (a running
 * eval is requeued at once) and close the server; connections still open
 * after `graceMs` (SSE metric streams, which clients resume with
 * Last-Event-ID) are cut, so shutdown always finishes. A step that fails is
 * logged and the rest still run; the result is false if any failed.
 */
export const gracefulShutdown = async (
  steps: ShutdownSteps,
): Promise<boolean> => {
  let ok = true;
  const run = async (step: string, fn: () => Promise<unknown>) => {
    await fn().catch((error: unknown) => {
      ok = false;
      log("error", "shutdown step failed", { step, error });
    });
  };

  steps.startDraining();
  if (steps.drainMs) await sleep(steps.drainMs);
  await run("stop_background", steps.stopBackground);
  await Promise.all(
    steps.servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          const cut = setTimeout(
            () => server.closeAllConnections(),
            steps.graceMs ?? 5_000,
          );
          cut.unref();
          server.close(() => {
            clearTimeout(cut);
            resolve();
          });
        }),
    ),
  );
  // Only once no listener has a request in flight.
  await run("close_resources", steps.closeResources);

  return ok;
};
