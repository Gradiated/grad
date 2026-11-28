import { scopesImply, type AuthPrincipal } from "../adapters.js";
import { WORKSPACE_SCOPES, type ApiKeyScope } from "../contracts.js";

/** The roles Gradiated Cloud members (and their keys) have. */
const CLOUD_ROLES = ["admin", "member"] as const;
type CloudRole = (typeof CLOUD_ROLES)[number];

/**
 * A role's grad scopes. Admins have every workspace scope. Members train:
 * datasets, runs (evals included) and artifacts, and they can read sources;
 * secrets and source writes stay with admins.
 */
const ROLE_SCOPES: Record<CloudRole, readonly ApiKeyScope[]> = {
  admin: ["admin"],
  member: [
    "datasets:read",
    "datasets:write",
    "runs:read",
    "runs:write",
    "artifacts:read",
    "artifacts:write",
    "sources:read",
  ],
};

export const isCloudRole = (role: unknown): role is CloudRole =>
  role === "admin" || role === "member";

/**
 * The scopes of a key or token with `role` and optional per-key `scopes`:
 * none or empty means the role's full rights; a non-empty list is narrowed
 * to what the role allows (unknown names are dropped).
 */
export const scopesFor = (
  role: CloudRole,
  scopes: readonly string[] | null | undefined,
): ApiKeyScope[] => {
  const granted = ROLE_SCOPES[role];
  if (!scopes || scopes.length === 0) return [...granted];

  return [
    ...new Set(
      scopes.filter(
        (s): s is ApiKeyScope =>
          KNOWN_SCOPES.has(s) && scopesImply(granted, s as ApiKeyScope),
      ),
    ),
  ];
};

const KNOWN_SCOPES: ReadonlySet<string> = new Set(WORKSPACE_SCOPES);

/** A Cloud member's (or member key's) principal in `workspaceId`. */
export const cloudPrincipal = (input: {
  workspaceId: string;
  actor: string;
  role: CloudRole;
  scopes: readonly string[] | null | undefined;
}): AuthPrincipal => ({
  kind: "workspace",
  workspaceId: input.workspaceId,
  actor: input.actor,
  scopes: scopesFor(input.role, input.scopes),
  workerWorkspaceId: null,
});
