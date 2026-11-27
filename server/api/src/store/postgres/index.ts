import { Pool } from "pg";

import type { Clock } from "../../clock.js";
import { migrate } from "../migrate.js";
import type { Repositories, Store } from "../types.js";
import {
  createApiKeyRepository,
  createDatasetRepository,
  createImportJobRepository,
  createUploadRepository,
} from "./core.js";
import { createDb } from "./db.js";
import { createEvalRepository } from "./evals.js";
import { createIdempotencyRepository } from "./idempotency.js";
import {
  createArtifactRepository,
  createBillingOutboxRepository,
  createCheckpointRepository,
  createMetricsRepository,
  createRunRepository,
} from "./runs.js";
import {
  createDeploymentRepository,
  createFeedbackRepository,
  createInferenceRepository,
} from "./serving.js";

export interface PostgresStoreOptions {
  connectionString: string;
  clock: Clock;
  /** Schema to create and use (search_path); tests isolate with one per case. */
  schema?: string;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

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
    ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
  });
  pool.on("error", (error) => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "postgres pool error",
        error: error.message,
      }),
    );
  });

  const db = createDb(pool);
  const { clock } = options;
  const repos: Repositories = {
    apiKeys: createApiKeyRepository(db, clock),
    datasets: createDatasetRepository(db, clock),
    imports: createImportJobRepository(db, clock),
    runs: createRunRepository(db, clock),
    metrics: createMetricsRepository(db),
    checkpoints: createCheckpointRepository(db, clock),
    artifacts: createArtifactRepository(db, clock),
    uploads: createUploadRepository(db, clock),
    deployments: createDeploymentRepository(db, clock),
    inferences: createInferenceRepository(db, clock),
    feedback: createFeedbackRepository(db, clock),
    evals: createEvalRepository(db, clock),
    billing: createBillingOutboxRepository(db, clock),
    idempotency: createIdempotencyRepository(db),
  };

  return {
    ...repos,
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
    close: () => pool.end(),
  };
};
