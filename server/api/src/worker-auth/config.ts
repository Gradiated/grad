import { z } from "zod";

import {
  WORKER_JOB_KINDS,
  type TrainerKey,
  type WorkerJobKind,
} from "../adapters.js";
import { issuesOf } from "../errors.js";
import { WORKER_AUTH_MODES, type WorkerAuthMode } from "./principal.js";

export interface WorkerAuthConfig {
  /** GRAD_WORKER_AUTH, in order (default: static). */
  modes: WorkerAuthMode[];
  /** GRAD_WORKER_K8S_SERVICE_ACCOUNTS: `<namespace>/<name>` -> kinds. */
  serviceAccounts: Record<string, WorkerJobKind[]>;
  /**
   * GRAD_ORCHESTRATOR_KEYS_JSON: who may mint lease tokens, for which kinds.
   * Empty unless `lease` is enabled; the lease-token routes exist only then.
   */
  orchestratorKeys: TrainerKey[];
  /**
   * INTERNAL_PORT: the internal listener (lease-token routes and the Cloud
   * routes, each mounted when configured); unset: off.
   */
  internalPort: number | undefined;
}

const KindsSchema = z.array(z.enum(WORKER_JOB_KINDS)).min(1);
const SA_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?\/[a-z0-9]([-.a-z0-9]*[a-z0-9])?$/;

const parseJson = <T>(
  name: string,
  raw: string | undefined,
  schema: z.ZodType<T>,
  example: string,
): T | undefined => {
  if (!raw) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be JSON: ${example}.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid ${name}: ${issuesOf(parsed.error)}`);
  }

  return parsed.data;
};

const ServiceAccountsSchema = z.record(z.string(), KindsSchema);

const OrchestratorKeysSchema = z.array(
  z.strictObject({
    label: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "a lowercase SHA-256 hex digest"),
    kinds: KindsSchema,
  }),
);

/** Parses and cross-checks the worker-auth settings; `warnings` collects the harmless leftovers. */
export const parseWorkerAuthConfig = (
  env: {
    GRAD_WORKER_AUTH?: string | undefined;
    GRAD_WORKER_K8S_SERVICE_ACCOUNTS?: string | undefined;
    GRAD_ORCHESTRATOR_KEYS_JSON?: string | undefined;
    INTERNAL_PORT?: number | undefined;
    PORT: number;
    METRICS_PORT?: number | undefined;
    hasStaticKeys: boolean;
    /** AUTH_MODE=cloud: the Cloud internal routes verify service JWTs. */
    cloudRoutes: boolean;
  },
  warnings: string[],
): WorkerAuthConfig => {
  const modes = (env.GRAD_WORKER_AUTH ?? "static")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  for (const mode of modes) {
    if (!(WORKER_AUTH_MODES as readonly string[]).includes(mode)) {
      throw new Error(
        `GRAD_WORKER_AUTH: unknown mode '${mode}'; use a comma-separated list of ${WORKER_AUTH_MODES.join(", ")}.`,
      );
    }
  }
  if (modes.length === 0) {
    throw new Error(
      `GRAD_WORKER_AUTH must name at least one of ${WORKER_AUTH_MODES.join(", ")}.`,
    );
  }
  if (new Set(modes).size !== modes.length) {
    throw new Error("GRAD_WORKER_AUTH names a mode twice.");
  }
  const enabled = (mode: WorkerAuthMode) => modes.includes(mode);

  const serviceAccounts =
    parseJson(
      "GRAD_WORKER_K8S_SERVICE_ACCOUNTS",
      env.GRAD_WORKER_K8S_SERVICE_ACCOUNTS,
      ServiceAccountsSchema,
      '{"grad/grad-train-worker": ["train"]}',
    ) ?? {};
  const badAccount = Object.keys(serviceAccounts).find((k) => !SA_RE.test(k));
  if (badAccount !== undefined) {
    throw new Error(
      `GRAD_WORKER_K8S_SERVICE_ACCOUNTS: '${badAccount}' is not a '<namespace>/<service-account>' name.`,
    );
  }
  const orchestratorKeys =
    parseJson(
      "GRAD_ORCHESTRATOR_KEYS_JSON",
      env.GRAD_ORCHESTRATOR_KEYS_JSON,
      OrchestratorKeysSchema,
      '[{"label": "gpu-fleet", "sha256": "<hex>", "kinds": ["train"]}]',
    ) ?? [];
  const labels = orchestratorKeys.map((k) => k.label);
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) {
    throw new Error(
      `GRAD_ORCHESTRATOR_KEYS_JSON has two keys labelled '${dup}'.`,
    );
  }

  if (enabled("kubernetes") && Object.keys(serviceAccounts).length === 0) {
    throw new Error(
      'GRAD_WORKER_AUTH=kubernetes needs GRAD_WORKER_K8S_SERVICE_ACCOUNTS, e.g. {"grad/grad-train-worker": ["train"]}: unmapped service accounts are rejected.',
    );
  }
  if (!enabled("kubernetes") && Object.keys(serviceAccounts).length > 0) {
    warnings.push(
      "GRAD_WORKER_K8S_SERVICE_ACCOUNTS is ignored: GRAD_WORKER_AUTH does not include kubernetes.",
    );
  }
  if (!enabled("static") && env.hasStaticKeys) {
    warnings.push(
      "TRAINER_KEYS_JSON / TRAINER_API_KEY(_HASH) are ignored: GRAD_WORKER_AUTH does not include static.",
    );
  }

  const internalPort = env.INTERNAL_PORT;
  const leaseRoutes = enabled("lease") && orchestratorKeys.length > 0;
  if (orchestratorKeys.length > 0 && !enabled("lease")) {
    warnings.push(
      "GRAD_ORCHESTRATOR_KEYS_JSON is ignored: GRAD_WORKER_AUTH does not include lease.",
    );
  }
  if (internalPort !== undefined) {
    if (internalPort === env.PORT || internalPort === env.METRICS_PORT) {
      throw new Error("INTERNAL_PORT must differ from PORT and METRICS_PORT.");
    }
    if (!leaseRoutes && !env.cloudRoutes) {
      throw new Error(
        "INTERNAL_PORT would serve nothing: it needs the lease-token routes (lease in GRAD_WORKER_AUTH plus GRAD_ORCHESTRATOR_KEYS_JSON) or the Cloud routes (AUTH_MODE=cloud); configure one, or unset INTERNAL_PORT.",
      );
    }
    if (enabled("lease") && !leaseRoutes) {
      warnings.push(
        "GRAD_WORKER_AUTH includes lease but GRAD_ORCHESTRATOR_KEYS_JSON is empty: the internal listener serves no lease-token routes.",
      );
    }
  } else {
    if (leaseRoutes) {
      warnings.push(
        "GRAD_ORCHESTRATOR_KEYS_JSON is ignored on this replica: INTERNAL_PORT is not set.",
      );
    }
    if (enabled("lease")) {
      warnings.push(
        "GRAD_WORKER_AUTH includes lease but INTERNAL_PORT is not set: this replica accepts lease tokens but cannot mint them.",
      );
    }
  }

  return {
    modes: modes as WorkerAuthMode[],
    serviceAccounts,
    orchestratorKeys: leaseRoutes ? orchestratorKeys : [],
    internalPort,
  };
};
