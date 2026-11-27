import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    postgresUrl: string | null;
    postgresSkipReason: string | null;
  }
}

const exec = promisify(execFile);

const waitForPostgres = async (url: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(
    `Postgres at ${url.replace(/:[^:@/]+@/, ":***@")} not ready: ${String(lastError)}`,
  );
};

/**
 * vitest globalSetup: provides `postgresUrl` from DATABASE_URL /
 * GRAD_TEST_DATABASE_URL, or a throwaway `gradr3-pg-*` container on a
 * loopback port (removed on teardown). Without either, Postgres suites skip
 * unless GRAD_REQUIRE_POSTGRES=1.
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const required = process.env.GRAD_REQUIRE_POSTGRES === "1";
  const configured =
    process.env.GRAD_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

  if (configured) {
    await waitForPostgres(configured, 30_000);
    project.provide("postgresUrl", configured);
    project.provide("postgresSkipReason", null);
    return async () => undefined;
  }

  const name = `gradr3-pg-${randomBytes(4).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  try {
    await exec("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:17-alpine",
      "-c",
      "max_connections=300",
      "-c",
      "fsync=off",
    ]);
  } catch (error) {
    const reason = `docker unavailable (${String(error).split("\n")[0]})`;
    if (required) throw new Error(`GRAD_REQUIRE_POSTGRES=1 but ${reason}`);
    console.warn(`[postgres] skipping Postgres suites: ${reason}`);
    project.provide("postgresUrl", null);
    project.provide("postgresSkipReason", reason);
    return async () => undefined;
  }

  const teardown = async () => {
    await exec("docker", ["rm", "-f", name]).catch(() => undefined);
  };

  try {
    const { stdout } = await exec("docker", ["port", name, "5432/tcp"]);
    const port = stdout.trim().split("\n")[0]?.split(":").pop();
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    await waitForPostgres(url, 60_000);
    project.provide("postgresUrl", url);
    project.provide("postgresSkipReason", null);
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}
