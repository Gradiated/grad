import { createStaticWorkerAuth, type TrainerKey } from "../adapters.js";
import type { Clock } from "../clock.js";
import type { WorkerTokenRepository } from "../store/types.js";
import type { WorkerAuthConfig } from "./config.js";
import {
  createKubernetesWorkerAuth,
  inClusterTokenReviewer,
  type TokenReviewer,
} from "./kubernetes.js";
import { createLeaseWorkerAuth } from "./lease.js";
import {
  chainWorkerAuthenticators,
  type WorkerAuthenticator,
} from "./principal.js";

/** The configured authenticators, chained in GRAD_WORKER_AUTH order. */
export const buildWorkerAuthenticator = (
  config: Pick<WorkerAuthConfig, "modes" | "serviceAccounts">,
  deps: {
    staticKeys: readonly TrainerKey[];
    tokens: WorkerTokenRepository;
    clock: Clock;
    review?: TokenReviewer | undefined;
  },
): WorkerAuthenticator =>
  chainWorkerAuthenticators(
    config.modes.map((mode) => {
      switch (mode) {
        case "static":
          return createStaticWorkerAuth(deps.staticKeys);
        case "kubernetes":
          return createKubernetesWorkerAuth({
            serviceAccounts: config.serviceAccounts,
            review: deps.review ?? inClusterTokenReviewer(),
            clock: deps.clock,
          });
        case "lease":
          return createLeaseWorkerAuth({
            tokens: deps.tokens,
            clock: deps.clock,
          });
      }
    }),
  );
