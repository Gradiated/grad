import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);

/** Same image and digest as the CI Postgres service. */
export const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73";

/** Every throwaway test database is named `gradr5-pg-<pid>`. */
export const CONTAINER_PREFIX = "gradr5-pg-";

const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export const waitForPostgres = async (url: string, timeoutMs: number) => {
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
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(
    `Postgres at ${url.replace(/:[^:@/]+@/, ":***@")} not ready: ${String(lastError)}`,
  );
};

/** Removes `<prefix>*` containers older than 2 h (left behind by a SIGKILL). */
export const reapStaleContainers = async (
  prefix = CONTAINER_PREFIX,
): Promise<void> => {
  const { stdout } = await exec("docker", [
    "ps",
    "-aq",
    "--filter",
    `name=^${prefix}`,
  ]);
  const ids = stdout.split("\n").filter(Boolean);
  if (ids.length === 0) return;
  const inspected = await exec("docker", [
    "inspect",
    "--format",
    "{{.Name}} {{.Created}}",
    ...ids,
  ]);
  const stale = inspected.stdout
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter(
      ([name, created]) =>
        name?.startsWith(`/${prefix}`) &&
        Date.now() - Date.parse(created ?? "") > STALE_AFTER_MS,
    )
    .map(([name]) => (name as string).slice(1));
  if (stale.length > 0) await exec("docker", ["rm", "-f", ...stale]);
};

export interface DockerPostgres {
  url: string;
  stop: () => Promise<void>;
}

/** Starts `gradr5-pg-<pid>` on a random loopback port and waits until it accepts connections. */
export const startDockerPostgres = async (): Promise<DockerPostgres> => {
  await reapStaleContainers().catch(() => undefined);
  const name = `${CONTAINER_PREFIX}${process.pid}`;
  const password = randomBytes(12).toString("hex");
  const stop = async () => {
    await exec("docker", ["rm", "-f", name]).catch(() => undefined);
  };
  await stop();
  await exec(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-p",
      "127.0.0.1::5432",
      POSTGRES_IMAGE,
      "-c",
      "max_connections=300",
      "-c",
      "fsync=off",
    ],
    { timeout: 120_000 },
  );
  try {
    const { stdout } = await exec("docker", ["port", name, "5432/tcp"]);
    const port = stdout.trim().split("\n")[0]?.split(":").pop();
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    await waitForPostgres(url, 60_000);
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};
