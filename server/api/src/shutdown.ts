import type { Server } from "node:http";

interface ShutdownSteps {
  /** The HTTP server; stops accepting at once, open streams get `graceMs`. */
  server: Pick<Server, "close" | "closeAllConnections">;
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
 * Last-Event-ID) are cut, so shutdown always finishes.
 */
export const gracefulShutdown = async (steps: ShutdownSteps): Promise<void> => {
  steps.startDraining();
  if (steps.drainMs) await sleep(steps.drainMs);
  await steps.stopBackground();
  await new Promise<void>((resolve) => {
    const cut = setTimeout(
      () => steps.server.closeAllConnections(),
      steps.graceMs ?? 5_000,
    );
    cut.unref();
    steps.server.close(() => {
      clearTimeout(cut);
      resolve();
    });
  });
  await steps.closeResources();
};
