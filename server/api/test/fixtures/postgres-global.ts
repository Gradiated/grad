import type { TestProject } from "vitest/node";

import { startDockerPostgres, waitForPostgres } from "./docker-postgres.js";

declare module "vitest" {
  export interface ProvidedContext {
    postgresUrl: string;
  }
}

/**
 * vitest globalSetup: provides `postgresUrl` from GRAD_TEST_DATABASE_URL (the
 * CI service), or a throwaway `gradr5-pg-<pid>` container removed on teardown.
 * Every test file gets its own schema in that database (fixtures/postgres.ts).
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const configured = process.env.GRAD_TEST_DATABASE_URL;
  if (configured) {
    await waitForPostgres(configured, 30_000);
    project.provide("postgresUrl", configured);
    return async () => undefined;
  }

  const pg = await startDockerPostgres().catch((error: unknown) => {
    throw new Error(
      `The server tests need Postgres: set GRAD_TEST_DATABASE_URL or make docker available (${String(error).split("\n")[0]}).`,
    );
  });
  project.provide("postgresUrl", pg.url);
  return pg.stop;
}
