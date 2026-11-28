import { Client, Pool } from "pg";

import type { Clock } from "../../clock.js";
import { log } from "../../telemetry/log.js";
import { migrate } from "../migrate.js";
import type { Repositories, Store } from "../types.js";
import { createArtifactRepository } from "./artifacts.js";
import { createApiKeyRepository, createDatasetRepository } from "./core.js";
import { createDb } from "./db.js";
import { createEvalRepository } from "./evals.js";
import { createJobRepository } from "./jobs.js";
import { createImportJobRepository, createRunRepository } from "./runs.js";
import { createSecretRepository, createSourceRepository } from "./sources.js";
import { createTelemetryRepository } from "./telemetry.js";
import { createUsageRepository } from "./usage.js";
import { createWorkspaceRepository } from "./workspaces.js";
import { createWorkerTokenRepository } from "./worker-tokens.js";
import { postgresConnection } from "./tls.js";
import { watchPool } from "../../telemetry/metrics.js";

export interface PostgresStoreOptions {
  connectionString: string;
  clock: Clock;
  /** Schema to create and use (search_path); tests isolate with one per case. */
  schema?: string;
  /** Client-side bound on one query (default QUERY_TIMEOUT_MS); tests shorten it. */
  queryTimeoutMs?: number;
  /** How often a LISTEN connection proves it is alive (default LISTEN_PING_MS). */
  listenPingMs?: number;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Fail fast instead of hanging when Postgres is down or a failover leaves a
 * dead TCP connection: a request waits at most 5 s for a connection, a
 * statement runs at most 30 s, an abandoned transaction is ended after 60 s,
 * and TCP keepalive probes an idle peer after 10 s. A peer that vanished
 * without a RST can't enforce statement_timeout, so the client gives up on a
 * query after QUERY_TIMEOUT_MS and the pool drops that connection.
 */
export const POOL_TIMEOUTS = {
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
} as const;
export const STATEMENT_TIMEOUT_MS = 30_000;
export const QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 5_000;
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
/**
 * A LISTEN connection only reads, so a dead peer that sent no RST would go
 * unnoticed for the kernel's keepalive (minutes): it runs `SELECT 1` this
 * often and counts as lost when that fails.
 */
export const LISTEN_PING_MS = 30_000;

/**
 * PostgreSQL-backed Store. Repositories share one pool; `transaction` runs on
 * a single client and every repository call made inside it (directly or via
 * the top-level store) joins that transaction.
 */
export const createPostgresStore = (options: PostgresStoreOptions): Store => {
  if (options.schema !== undefined && !SCHEMA_RE.test(options.schema)) {
    throw new Error(`Invalid schema name '${options.schema}'.`);
  }
  const connection = postgresConnection(options.connectionString);
  const pool = new Pool({
    ...connection,
    ...POOL_TIMEOUTS,
    query_timeout: options.queryTimeoutMs ?? QUERY_TIMEOUT_MS,
    options: [
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
      ...(options.schema ? [`-c search_path=${options.schema}`] : []),
    ].join(" "),
  });
  const logLost = (error: Error) => {
    log("error", "postgres connection lost", { error });
  };
  // The pool listens for 'error' on idle clients only. A backend that dies
  // while a client is checked out (a transaction between two queries, during
  // a Postgres restart or failover) would emit an unhandled 'error' and exit
  // the process (r8 P1-2). With a listener, the query in flight or the next
  // one rejects instead, the request answers 503 and the pool drops the client.
  pool.on("error", logLost);
  pool.on("connect", (client) => client.on("error", logLost));

  const unwatch = watchPool(pool);
  const db = createDb(pool);
  const { clock } = options;
  const repos: Repositories = {
    apiKeys: createApiKeyRepository(db, clock),
    datasets: createDatasetRepository(db, clock),
    jobs: createJobRepository(db, clock),
    imports: createImportJobRepository(db, clock),
    runs: createRunRepository(db, clock),
    artifacts: createArtifactRepository(db, clock),
    evals: createEvalRepository(db, clock),
    usage: createUsageRepository(db, clock),
    secrets: createSecretRepository(db, clock),
    sources: createSourceRepository(db, clock),
    workerTokens: createWorkerTokenRepository(db),
    workspaces: createWorkspaceRepository(db),
  };

  return {
    ...repos,
    telemetry: createTelemetryRepository(db),
    transaction: (fn) => db.atomic(fn),
    migrate: async () => {
      // Its own connection: the serving pool's client-side query timeout
      // would cut a long migration off.
      const migrator = new Pool({
        ...connection,
        max: 1,
      });
      migrator.on("error", logLost);
      try {
        await migrate(migrator, { schema: options.schema });
      } finally {
        await migrator.end();
      }
    },
    ping: async () => {
      try {
        await db.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    dbNow: async () => {
      const rows = await db.query<{ now: Date }>("SELECT now() AS now");

      return new Date(rows[0]?.now ?? Date.now());
    },
    unreferencedKeys: async (keys) =>
      keys.length === 0
        ? []
        : (
            await db.query<{ key: string }>(
              `SELECT k.key FROM unnest($1::text[]) AS k(key)
               WHERE NOT EXISTS (SELECT 1 FROM grad_artifacts a WHERE a.storage_key = k.key)
                 AND NOT EXISTS (SELECT 1 FROM grad_dataset_parts p WHERE p.key = k.key)`,
              [[...keys]],
            )
          ).map((r) => r.key),
    listen: async (channel, onPayload, onLost) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(channel)) {
        throw new Error(`Invalid channel name '${channel}'.`);
      }
      const pingMs = options.listenPingMs ?? LISTEN_PING_MS;
      const client = new Client({
        ...connection,
        ...POOL_TIMEOUTS,
        query_timeout: pingMs,
      });
      let open = true;
      let ping: NodeJS.Timeout | undefined;
      const lost = (error: Error) => {
        if (!open) return;
        open = false;
        clearInterval(ping);
        onLost(error);
        // A dead peer never answers the terminate message: drop the socket.
        void client.end().catch(() => undefined);
        (
          client as unknown as { connection?: { stream?: { destroy(): void } } }
        ).connection?.stream?.destroy();
      };
      client.on("notification", (message) => {
        if (message.channel === channel) onPayload(message.payload ?? "");
      });
      client.on("error", lost);
      client.on("end", () => lost(new Error("LISTEN connection ended")));
      try {
        await client.connect();
        await client.query(`LISTEN ${channel}`);
      } catch (error) {
        open = false;
        await client.end().catch(() => undefined);
        throw error;
      }
      ping = setInterval(() => {
        client
          .query("SELECT 1")
          .catch((error: unknown) =>
            lost(error instanceof Error ? error : new Error(String(error))),
          );
      }, pingMs);
      ping.unref();

      return async () => {
        open = false;
        clearInterval(ping);
        await client.end().catch(() => undefined);
      };
    },
    close: () => {
      unwatch();

      return pool.end();
    },
  };
};
