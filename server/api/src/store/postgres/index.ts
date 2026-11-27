import { Client, Pool } from "pg";

import type { Clock } from "../../clock.js";
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
import { createWorkerTokenRepository } from "./worker-tokens.js";
import { watchPool } from "../../telemetry/metrics.js";

export interface PostgresStoreOptions {
  connectionString: string;
  clock: Clock;
  /** Schema to create and use (search_path); tests isolate with one per case. */
  schema?: string;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Fail fast instead of hanging when Postgres is down or a failover leaves a
 * dead TCP connection: a request waits at most 5 s for a connection, a
 * statement runs at most 30 s, an abandoned transaction is ended after 60 s,
 * and TCP keepalive notices a vanished peer.
 */
export const POOL_TIMEOUTS = {
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
} as const;
export const STATEMENT_TIMEOUT_MS = 30_000;
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * PostgreSQL-backed Store. Repositories share one pool; `transaction` runs on
 * a single client and every repository call made inside it (directly or via
 * the top-level store) joins that transaction.
 */
export const createPostgresStore = (options: PostgresStoreOptions): Store => {
  if (options.schema !== undefined && !SCHEMA_RE.test(options.schema)) {
    throw new Error(`Invalid schema name '${options.schema}'.`);
  }
  const pool = new Pool({
    connectionString: options.connectionString,
    ...POOL_TIMEOUTS,
    options: [
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
      ...(options.schema ? [`-c search_path=${options.schema}`] : []),
    ].join(" "),
  });
  const logLost = (error: Error) => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "postgres connection lost",
        error: error.message,
      }),
    );
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
  };

  return {
    ...repos,
    telemetry: createTelemetryRepository(db),
    transaction: (fn) => db.atomic(() => fn(repos)),
    migrate: async () => {
      await migrate(pool, { schema: options.schema });
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
      const client = new Client({
        connectionString: options.connectionString,
        ...POOL_TIMEOUTS,
      });
      let open = true;
      const lost = (error: Error) => {
        if (!open) return;
        open = false;
        onLost(error);
        void client.end().catch(() => undefined);
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

      return async () => {
        open = false;
        await client.end().catch(() => undefined);
      };
    },
    close: () => {
      unwatch();

      return pool.end();
    },
  };
};
