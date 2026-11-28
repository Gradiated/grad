import { createHash, timingSafeEqual } from "node:crypto";

import type { ApiKeyScope, JobKind, Scope } from "./contracts.js";
import { JOB_KINDS, PLATFORM_SCOPES } from "./contracts.js";
import type { KeyLookupResult } from "./store/types.js";
import {
  authenticateWorkerFirst,
  type WorkerAuthenticator,
  type WorkerPrincipal,
} from "./worker-auth/principal.js";

export interface AuthPrincipal {
  kind: "workspace" | "worker" | "dev";
  workspaceId: string;
  actor: string;
  scopes: readonly Scope[];
  /**
   * Trainer workers only: the single workspace this worker may serve, or null
   * for a platform worker that serves every workspace.
   */
  workerWorkspaceId: string | null;
  /**
   * Trainer workers only: the job kinds this key may claim. Import jobs carry
   * workspace secrets, so a GPU host's key is train-only (TRAINER_KEYS_JSON).
   */
  workerKinds?: readonly JobKind[];
  /** Trainer workers only: what the worker token proved (host binding, GPU bound, expiry). */
  worker?: WorkerPrincipal | undefined;
}

/** One trainer key: `TRAINER_API_KEY(_HASH)` (every kind) or a `TRAINER_KEYS_JSON` entry. */
export interface TrainerKey {
  label: string;
  sha256: string;
  kinds: readonly JobKind[];
}

/** The configured trainer keys: the single platform key first, then the labelled ones. */
export const trainerKeysOf = (
  trainerKeyHash: string | undefined,
  extra: readonly TrainerKey[] = [],
): TrainerKey[] => [
  ...(trainerKeyHash
    ? [{ label: "trainer", sha256: trainerKeyHash, kinds: JOB_KINDS }]
    : []),
  ...extra,
];

export interface AuthAdapter {
  /** Returns null for an invalid token; throws ApiError(503) when unavailable. */
  authenticate(bearerToken: string | undefined): Promise<AuthPrincipal | null>;
}

/**
 * One billed ledger row as Gradiated Cloud's billing ingest takes it (the
 * `usage_events` schema); `event_id` is the row's idempotency key.
 */
export interface UsageEvent {
  event_id: string;
  workspace_id: string;
  product: "training";
  sku: string;
  quantity: number;
  amount_nano_usd: number;
  price_version: string;
  occurred_at: string;
  subject_id: string;
  tags: Record<string, string>;
}

/**
 * Billing ingest refused a usage batch for good (HTTP 422 or 409): a replay
 * would be refused again. `eventId` names the refused event when ingest says.
 */
export class UsageRefusedError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly eventId: string | undefined,
  ) {
    super(message);
  }
}

export interface BillingAdapter {
  checkCanStartRun(
    workspaceId: string,
    estimatedCostUsd: number,
  ): Promise<{ allowed: boolean; reason?: string }>;
  /**
   * Cloud only: false when the workspace is out of balance or over its limit,
   * so running jobs are told to stop (insufficient_balance). Absent: never.
   */
  canContinue?(workspaceId: string): Promise<boolean>;
  /**
   * Cloud only: pushes ledger rows to billing (idempotent by event_id; a
   * replay is free). Absent on self-hosted servers: the ledger stays local.
   * Throws UsageRefusedError when billing refuses the batch for good.
   */
  pushUsage?(events: readonly UsageEvent[]): Promise<void>;
  /**
   * Cloud only: the inference gateway bills eval model and judge tokens, so
   * eval ledger rows are recorded `billed_by: gateway` and never pushed.
   */
  gatewayBillsEvals?: boolean;
}

export const hashApiKey = (rawKey: string): string =>
  createHash("sha256").update(rawKey).digest("hex");

const HEX_64_RE = /^[0-9a-f]{64}$/i;

const safeDigestEqual = (hexA: string, hexB: string): boolean => {
  if (!HEX_64_RE.test(hexA) || !HEX_64_RE.test(hexB)) return false;

  return timingSafeEqual(Buffer.from(hexA, "hex"), Buffer.from(hexB, "hex"));
};

const isPlatformScope = (scope: Scope): boolean =>
  (PLATFORM_SCOPES as readonly string[]).includes(scope);

/**
 * Scope check. `admin` implies every workspace scope and `x:write` implies
 * `x:read`, but platform scopes (`trainer:worker`) are never implied.
 */
export const hasScope = (
  principal: AuthPrincipal,
  required: Scope,
): boolean => {
  if (principal.scopes.includes(required)) return true;
  if (isPlatformScope(required)) return false;
  if (principal.scopes.includes("admin")) return true;

  if (required.endsWith(":read")) {
    const write = `${required.slice(0, -":read".length)}:write` as Scope;
    return principal.scopes.includes(write);
  }

  return false;
};

/** Development only: every request is a platform admin and trainer worker. */
export const createLocalNoneAuth = (workspaceId = "local"): AuthAdapter => ({
  authenticate: async () => ({
    kind: "dev",
    workspaceId,
    actor: "local-dev",
    scopes: ["admin", "trainer:worker"],
    workerWorkspaceId: null,
  }),
});

export interface KeyLookup {
  findActiveByHash(keyHash: string): Promise<KeyLookupResult | null>;
}

const assertDigest = (name: string, value: string | undefined): void => {
  if (value !== undefined && !HEX_64_RE.test(value)) {
    throw new Error(`${name} must be a 64-character SHA-256 hex digest.`);
  }
};

/**
 * Static worker keys (GRAD_WORKER_AUTH=static): the token's SHA-256 against
 * every configured key, in constant time and without stopping at a match.
 */
export const findKeyByToken = <K extends { sha256: string }>(
  token: string,
  keys: readonly K[],
): K | null => {
  const digest = hashApiKey(token);
  let key: K | null = null;
  for (const candidate of keys) {
    if (safeDigestEqual(digest, candidate.sha256) && key === null) {
      key = candidate;
    }
  }

  return key;
};

export const matchStaticWorkerKey = (
  token: string,
  keys: readonly TrainerKey[],
): WorkerPrincipal | null => {
  const key = findKeyByToken(token, keys);
  if (!key) return null;

  return {
    kinds: key.kinds,
    identity:
      key.label === "trainer"
        ? "trainer-worker"
        : `trainer-worker:${key.label}`,
  };
};

export const createStaticWorkerAuth = (
  keys: readonly TrainerKey[],
): WorkerAuthenticator => ({
  mode: "static",
  authenticate: async (token) => matchStaticWorkerKey(token, keys),
});

/** The kinds `principal` may claim out of `requested` (every kind for non-key workers). */
export const claimableKinds = <K extends string>(
  principal: AuthPrincipal,
  requested: readonly K[],
): K[] =>
  requested.filter(
    (kind) =>
      principal.workerKinds === undefined ||
      (principal.workerKinds as readonly string[]).includes(kind),
  );

export const createLocalApiKeyAuth = (options: {
  adminKeyHash?: string | undefined;
  trainerKeyHash?: string | undefined;
  trainerKeys?: readonly TrainerKey[] | undefined;
  /** The worker authenticator chain (default: the static trainer keys). */
  workers?: WorkerAuthenticator | undefined;
  workspaceId?: string;
  lookup: KeyLookup;
}): AuthAdapter => {
  const defaultWorkspaceId = options.workspaceId ?? "default";
  assertDigest("adminKeyHash", options.adminKeyHash);
  assertDigest("trainerKeyHash", options.trainerKeyHash);
  const workers =
    options.workers ??
    createStaticWorkerAuth(
      trainerKeysOf(options.trainerKeyHash, options.trainerKeys),
    );

  const workspaceKey = async (token: string): Promise<AuthPrincipal | null> => {
    const digest = hashApiKey(token);
    if (options.adminKeyHash && safeDigestEqual(digest, options.adminKeyHash)) {
      return {
        kind: "workspace",
        workspaceId: defaultWorkspaceId,
        actor: "bootstrap-admin",
        scopes: ["admin"],
        workerWorkspaceId: null,
      };
    }

    const key = await options.lookup.findActiveByHash(digest);
    if (!key) return null;

    return {
      kind: "workspace",
      workspaceId: key.workspace_id,
      actor: `key:${key.name}`,
      scopes: key.scopes as ApiKeyScope[],
      workerWorkspaceId: null,
    };
  };

  return {
    authenticate: async (bearerToken) => {
      const token = bearerToken?.trim();
      if (!token) return null;

      return authenticateWorkerFirst(workers, token, () => workspaceKey(token));
    },
  };
};

export const createNoopBillingAdapter = (): BillingAdapter => ({
  checkCanStartRun: async () => ({ allowed: true }),
});

/** One page of Gradiated Cloud gateway traces and scores (the `gradiated` source). */
export interface TracesPage {
  records: Record<string, unknown>[];
  cursor: string | null;
  has_more: boolean;
}

/** Cloud only: reads gateway traces for a workspace; null when self-hosted. */
export interface TracesAdapter {
  pull(input: {
    workspaceId: string;
    filter: Record<string, unknown>;
    cursor: string | null;
    limit: number;
  }): Promise<TracesPage>;
}
