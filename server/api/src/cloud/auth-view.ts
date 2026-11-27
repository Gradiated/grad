import pg from "pg";

/** One usable principal from the product's `auth_principals_v1` view. */
export interface AuthViewRow {
  api_key_id: string;
  org_id: string;
  org_slug: string;
  workspace_id: string;
  user_id: string;
  /** `key:<api_key_id>`. */
  actor: string;
  role: string;
  /** `active`, or `suspended` (organization suspended, workspace archived, creator inactive). */
  status: string;
  /** NULL or empty: the role's full rights. */
  scopes: string[] | null;
  expires_at: Date | null;
}

export interface AuthView {
  /** The principal whose key has SHA-256 `digest`, or null. Throws when the database is unreachable. */
  find(digest: Buffer): Promise<AuthViewRow | null>;
  close(): Promise<void>;
}

/**
 * Reads `auth_principals_v1` over its own small, read-only pool (role
 * `grad_auth_reader`, CONNECTION LIMIT 10 across replicas). The view returns
 * only usable rows, so no business rules live here; expiry is checked by the
 * caller against the app clock.
 */
export const createAuthView = (connectionString: string): AuthView => {
  const pool = new pg.Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    // Not `options`: the URL may carry its own (a search_path, say).
    statement_timeout: 2_000,
    query_timeout: 3_000,
  });
  // An idle client's error must not crash the process; the next query fails.
  pool.on("error", () => undefined);

  return {
    find: async (digest) => {
      const { rows } = await pool.query<AuthViewRow>(
        `SELECT api_key_id::text, org_id::text, org_slug, workspace_id::text,
                user_id::text, actor, role, status, scopes, expires_at
           FROM auth_principals_v1 WHERE key_hash = $1 LIMIT 1`,
        [digest],
      );

      return rows[0] ?? null;
    },
    close: () => pool.end(),
  };
};
