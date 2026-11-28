import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { systemClock } from "../src/clock.js";
import { createAuthView } from "../src/cloud/auth-view.js";
import { runMigrations } from "../src/migrations.js";
import { createPostgresStore } from "../src/store/postgres/index.js";
import { postgresConnection } from "../src/store/postgres/tls.js";
import {
  CONTAINER_PREFIX,
  POSTGRES_IMAGE,
  waitForPostgres,
} from "./fixtures/docker-postgres.js";

const exec = promisify(execFile);

describe("postgresConnection", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "grad-pg-conn-"));
    for (const f of ["ca.pem", "client.crt", "client.key"]) {
      await writeFile(path.join(dir, f), `${f} contents`);
    }
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("leaves the URL alone without a CA bundle", () => {
    const url = "postgres://grad:p%40ss@db:5432/grad?sslmode=no-verify";
    expect(postgresConnection(url, undefined)).toEqual({
      connectionString: url,
    });
    expect(postgresConnection(url, " ")).toEqual({ connectionString: url });
  });

  it("verifies against the bundle whatever the URL says, keeping a client certificate", () => {
    const { connectionString, ssl } = postgresConnection(
      `postgres://grad:p%40ss@db.example.com:5432/grad?sslmode=no-verify&ssl=false&sslrootcert=/elsewhere.pem&sslcert=${dir}/client.crt&sslkey=${dir}/client.key&application_name=grad`,
      path.join(dir, "ca.pem"),
    );
    expect(connectionString).toBe(
      "postgres://grad:p%40ss@db.example.com:5432/grad?application_name=grad",
    );
    expect(ssl).toEqual({
      ca: "ca.pem contents",
      cert: "client.crt contents",
      key: "client.key contents",
    });
  });

  it("checks an IP address host against the certificate's IP names", () => {
    for (const url of [
      "postgres://g@10.0.0.5/grad",
      "postgres://g@[::1]:5432/grad",
      "postgres://g@ignored/grad?host=10.0.0.5",
    ]) {
      const { ssl } = postgresConnection(url, path.join(dir, "ca.pem"));
      expect(ssl?.checkServerIdentity, url).toBeTypeOf("function");
    }
    expect(
      postgresConnection("postgres://g@db/grad", path.join(dir, "ca.pem")).ssl
        ?.checkServerIdentity,
    ).toBeUndefined();
  });

  it("refuses a key=value connection string with a CA bundle", () => {
    expect(() => postgresConnection("host=db dbname=grad", "/ca.pem")).toThrow(
      /must be a postgres:\/\/ URL/,
    );
  });
});

// A Postgres serving TLS with a certificate for `localhost` only, issued by a
// throwaway CA; a second CA signed nothing.
describe("verify-full against a self-signed CA (Docker Postgres)", () => {
  const name = `${CONTAINER_PREFIX}tls-${process.pid}`;
  let dir = "";
  let port = "";
  const password = "grad-tls-test-only";
  const url = (host: string, query = "") =>
    `postgres://postgres:${password}@${host}:${port}/postgres${query}`;
  const openssl = (...args: string[]) =>
    exec("openssl", args, { cwd: dir, timeout: 30_000 });
  const ca = (file: string) => {
    process.env.PGSSLROOTCERT = path.join(dir, file);
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "grad-pg-tls-"));
    const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"];
    for (const cn of ["ca", "other-ca"]) {
      await openssl(
        "req", "-x509", ...ec, "-nodes", "-days", "1", "-subj", `/CN=grad-test-${cn}`,
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        "-keyout", `${cn}.key`, "-out", `${cn}.pem`,
      ); // prettier-ignore
    }
    await openssl(
      "req", ...ec, "-nodes", "-subj", "/CN=localhost",
      "-keyout", "server.key", "-out", "server.csr",
    ); // prettier-ignore
    await writeFile(
      path.join(dir, "san.ext"),
      "subjectAltName=DNS:localhost\n",
    );
    await openssl(
      "x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
      "-CAcreateserial", "-days", "1", "-extfile", "san.ext", "-out", "server.crt",
    ); // prettier-ignore

    const [cert, key] = await Promise.all(
      ["server.crt", "server.key"].map((f) =>
        readFile(path.join(dir, f), "utf8"),
      ),
    );
    await exec("docker", ["rm", "-f", name]).catch(() => undefined);
    await exec(
      "docker",
      [
        "run", "-d", "--rm", "--name", name,
        "-e", `POSTGRES_PASSWORD=${password}`, "-e", `TLS_CERT=${cert}`, "-e", `TLS_KEY=${key}`,
        "-p", "127.0.0.1::5432", "--entrypoint", "sh", POSTGRES_IMAGE, "-c",
        'mkdir -p /tls && printf "%s" "$TLS_CERT" > /tls/server.crt && printf "%s" "$TLS_KEY" > /tls/server.key' +
          " && chown -R postgres /tls && chmod 600 /tls/server.key" +
          " && exec docker-entrypoint.sh postgres -c fsync=off -c ssl=on" +
          " -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tls/server.key",
      ],
      { timeout: 120_000 },
    ); // prettier-ignore
    const { stdout } = await exec("docker", ["port", name, "5432/tcp"]);
    port = stdout.trim().split("\n")[0]?.split(":").pop() ?? "";
    await waitForPostgres(url("127.0.0.1", "?sslmode=disable"), 60_000);
  });

  afterEach(() => {
    delete process.env.PGSSLROOTCERT;
  });

  afterAll(async () => {
    await exec("docker", ["rm", "-f", name]).catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("connects over verified TLS with the right CA, even when the URL says no-verify", async () => {
    ca("ca.pem");
    const client = new pg.Client(
      postgresConnection(url("localhost", "?sslmode=no-verify")),
    );
    await client.connect();
    try {
      const { rows } = await client.query<{ ssl: boolean }>(
        "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
      );
      expect(rows).toEqual([{ ssl: true }]);
    } finally {
      await client.end();
    }
  });

  it("the migrations Job and the store connect with the right CA", async () => {
    ca("ca.pem");
    const schema = `tls_${process.pid}`;
    expect(
      (await runMigrations(url("localhost"), { schema })).length,
    ).toBeGreaterThan(0);
    const store = createPostgresStore({
      connectionString: url("localhost"),
      clock: systemClock,
      schema,
    });
    try {
      expect(await store.ping()).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("refuses a server whose certificate another CA issued", async () => {
    ca("other-ca.pem");
    await expect(runMigrations(url("localhost"))).rejects.toThrow(
      /self[- ]signed certificate|unable to (verify|get local issuer)/i,
    );
    const view = createAuthView(url("localhost"));
    try {
      await expect(view.find(Buffer.from("x"))).rejects.toThrow(
        /self[- ]signed certificate|unable to (verify|get local issuer)/i,
      );
    } finally {
      await view.close();
    }
  });

  // node-postgres alone would check an IP host against "localhost" and pass.
  it("refuses a host the certificate does not name", async () => {
    ca("ca.pem");
    await expect(runMigrations(url("127.0.0.1"))).rejects.toThrow(
      /IP: 127\.0\.0\.1 is not in the cert's list/,
    );
  });
});
