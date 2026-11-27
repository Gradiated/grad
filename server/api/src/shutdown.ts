import type { Server } from "node:http";

export interface ShutdownSteps {
  /** The HTTP server; stops accepting at once, open streams get `graceMs`. */
  server: Pick<Server, "close" | "closeAllConnections">;
  /** Background work that must hand its leases back (eval executor, maintenance). */
  stopBackground: () => Promise<void>;
  /** Pools and workers, closed last. */
  closeResources: () => Promise<void>;
  graceMs?: number;
}

/**
 * SIGTERM: stop background work first (so a running eval is requeued at once,
 * whatever the HTTP side does), then close the server; connections still open
 * after `graceMs` (SSE metric streams, which clients resume with
 * Last-Event-ID) are cut, so shutdown always finishes.
 */
export const gracefulShutdown = async (steps: ShutdownSteps): Promise<void> => {
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
