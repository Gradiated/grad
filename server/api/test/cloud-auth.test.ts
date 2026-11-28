import { generateKeyPairSync, sign } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createStaticWorkerAuth, hashApiKey } from "../src/adapters.js";
import { createCloudAuth } from "../src/cloud/auth.js";
import { createAuthView, type AuthView } from "../src/cloud/auth-view.js";
import { createJwtVerifier, looksLikeJwt } from "../src/cloud/jwt.js";
import { scopesFor } from "../src/cloud/roles.js";
import { ApiError } from "../src/errors.js";
import { makeTestApp } from "./fixtures/app.js";
import { ManualClock } from "./fixtures/clock.js";
import {
  startFakeCloudApi,
  type FakeCloudApi,
} from "./fixtures/fake-cloud-api.js";
import { postgresUrl } from "./fixtures/postgres.js";

const WS = "8f0e7c52-2d7e-4c39-9a51-0a5b3c1d2e3f";
const WORKER_KEY = "grad_worker_secret";

const expectApiError = async (
  promise: Promise<unknown>,
  status: number,
  code: string,
) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status, code });
};

describe("Cloud roles", () => {
  it("admins get every scope; members train; per-key scopes only narrow", () => {
    expect(scopesFor("admin", null)).toEqual(["admin"]);
    expect(scopesFor("member", [])).toEqual([
      "datasets:read",
      "datasets:write",
      "runs:read",
      "runs:write",
      "artifacts:read",
      "artifacts:write",
      "sources:read",
    ]);
    expect(
      scopesFor("member", ["runs:read", "secrets:write", "admin", "bogus"]),
    ).toEqual(["runs:read"]);
    expect(scopesFor("admin", ["secrets:write", "runs:read"])).toEqual([
      "secrets:write",
      "runs:read",
    ]);
  });
});

describe("Cloud auth: the auth_principals_v1 view, console JWTs, worker keys", () => {
  let cloud: FakeCloudApi;
  let clock: ManualClock;
  let view: AuthView;
  let lookups: number;

  beforeAll(async () => {
    clock = new ManualClock(new Date());
    cloud = await startFakeCloudApi({ databaseUrl: postgresUrl(), clock });
    const real = createAuthView(cloud.authDatabaseUrl as string);
    view = {
      find: async (digest) => {
        lookups += 1;
        return real.find(digest);
      },
      close: () => real.close(),
    };
  });
  afterAll(async () => {
    await view.close();
    await cloud.close();
  });
  beforeEach(() => {
    lookups = 0;
  });

  const auth = (options: { maxEntries?: number } = {}) =>
    createCloudAuth({
      view,
      jwt: createJwtVerifier({
        jwksUrl: cloud.jwksUrl,
        issuer: cloud.issuer,
        audience: "training",
        clock,
      }),
      workers: createStaticWorkerAuth([
        { label: "cpu", sha256: hashApiKey(WORKER_KEY), kinds: ["import"] },
      ]),
      clock,
      cache: options,
    });

  it("maps an admin key and a member key to their scopes; actor key:<id>", async () => {
    await cloud.addKey("grad_admin_1", { workspace_id: WS, role: "admin" });
    await cloud.addKey("grad_member_1", {
      workspace_id: WS,
      role: "member",
      scopes: ["runs:write", "secrets:write"],
    });
    const a = auth();

    expect(await a.authenticate("grad_admin_1")).toMatchObject({
      kind: "workspace",
      workspaceId: WS,
      scopes: ["admin"],
      isPlatformAdmin: false,
      actor: expect.stringMatching(/^key:[0-9a-f-]{36}$/),
    });
    expect(await a.authenticate("grad_member_1")).toMatchObject({
      scopes: ["runs:write"],
    });
    expect(await a.authenticate("grad_unknown")).toBeNull();
    expect(await a.authenticate(undefined)).toBeNull();
  });

  it("refuses a suspended principal with 403, cached like any answer", async () => {
    await cloud.addKey("grad_suspended", {
      workspace_id: WS,
      status: "suspended",
    });
    const a = auth();
    await expectApiError(
      a.authenticate("grad_suspended"),
      403,
      "workspace_suspended",
    );
    await expectApiError(
      a.authenticate("grad_suspended"),
      403,
      "workspace_suspended",
    );
    expect(lookups).toBe(1);
  });

  it("refuses expired keys", async () => {
    await cloud.addKey("grad_expired", {
      workspace_id: WS,
      expires_at: new Date(clock.now().getTime() - 1000),
    });
    expect(await auth().authenticate("grad_expired")).toBeNull();
  });

  it("never serves a cached key past its own expiry", async () => {
    await cloud.addKey("grad_expiring", {
      workspace_id: WS,
      expires_at: new Date(clock.now().getTime() + 2000),
    });
    const a = auth();
    expect(await a.authenticate("grad_expiring")).not.toBeNull();
    clock.advanceSeconds(3);
    expect(await a.authenticate("grad_expiring")).toBeNull();
  });

  it("caches answers for 5 s either way; concurrent requests share one lookup", async () => {
    await cloud.addKey("grad_cached", { workspace_id: WS });
    const a = auth();
    const all = await Promise.all(
      Array.from({ length: 5 }, () => a.authenticate("grad_cached")),
    );
    expect(all.every((p) => p?.workspaceId === WS)).toBe(true);
    expect(lookups).toBe(1);

    // Revoked: still valid until the positive TTL passes.
    await cloud.removeKey("grad_cached");
    clock.advanceSeconds(4);
    expect(await a.authenticate("grad_cached")).not.toBeNull();
    clock.advanceSeconds(2);
    expect(await a.authenticate("grad_cached")).toBeNull();

    // Created after a miss: found once the negative TTL passes.
    await cloud.addKey("grad_cached", { workspace_id: WS });
    expect(await a.authenticate("grad_cached")).toBeNull();
    clock.advanceSeconds(6);
    expect(await a.authenticate("grad_cached")).not.toBeNull();
    expect(lookups).toBe(3);
  });

  it("keeps the cache bounded (least recently used goes first)", async () => {
    const a = auth({ maxEntries: 2 });
    await cloud.addKey("grad_lru_1", { workspace_id: WS });
    await a.authenticate("grad_lru_1");
    await a.authenticate("grad_lru_2");
    await a.authenticate("grad_lru_1");
    await a.authenticate("grad_lru_3");
    expect(lookups).toBe(3);
    await a.authenticate("grad_lru_1");
    expect(lookups).toBe(3);
    await a.authenticate("grad_lru_2");
    expect(lookups).toBe(4);
  });

  it("fails closed: 503 auth_unavailable when the view is unreachable and nothing is cached", async () => {
    const dead = createAuthView("postgres://grad:x@127.0.0.1:9/product");
    const a = createCloudAuth({
      view: dead,
      jwt: createJwtVerifier({
        jwksUrl: cloud.jwksUrl,
        issuer: cloud.issuer,
        audience: "training",
        clock,
      }),
      workers: createStaticWorkerAuth([
        { label: "cpu", sha256: hashApiKey(WORKER_KEY), kinds: ["import"] },
      ]),
      clock,
    });
    await expectApiError(a.authenticate("grad_any"), 503, "auth_unavailable");
    // Worker keys never touch the view.
    expect(await a.authenticate(WORKER_KEY)).toMatchObject({
      kind: "worker",
      workerKinds: ["import"],
    });
    // Console JWTs are verified locally: no database involved.
    expect(await a.authenticate(cloud.consoleToken(WS))).toMatchObject({
      workspaceId: WS,
    });
    await dead.close();
  });

  it("verifies console JWTs: claims to a principal, bad tokens to null", async () => {
    const a = auth();
    const member = cloud.consoleToken(WS, "member");
    expect(looksLikeJwt(member)).toBe(true);
    expect(await a.authenticate(member)).toMatchObject({
      kind: "workspace",
      workspaceId: WS,
      actor: expect.stringMatching(/^user:/),
      scopes: expect.arrayContaining(["runs:write", "datasets:write"]),
    });
    expect(
      await a.authenticate(
        cloud.consoleToken(WS, "admin", { scopes: ["runs:read"] }),
      ),
    ).toMatchObject({ scopes: ["runs:read"] });

    const now = Math.floor(clock.now().getTime() / 1000);
    const claims = { sub: "user:u1", ws: WS, org: "o1", role: "admin" };
    const bad = [
      cloud.signJwt({ ...claims, exp: now - 61 }),
      cloud.signJwt({ ...claims, nbf: now + 120 }),
      cloud.signJwt({ ...claims, aud: "inference" }),
      cloud.signJwt({ ...claims, iss: "https://evil.example" }),
      cloud.signJwt({ ...claims, ws: undefined }),
      cloud.signJwt({ ...claims, ws: "../other" }),
      cloud.signJwt({ ...claims, role: "owner" }),
      cloud.signJwt({ ...claims, org: undefined }),
      // A service token is for the internal listener, not the public API.
      cloud.signJwt({ ...claims, sub: "service:inference" }),
      // Console tokens live 10 minutes: a year-long one is mis-issued or forged.
      cloud.signJwt({ ...claims, exp: now + 365 * 86_400 }),
      cloud.signJwt({ ...claims, exp: now + 3600 + 61 }),
    ];
    for (const token of bad) expect(await a.authenticate(token)).toBeNull();
    // Within the 60 s skew.
    expect(
      await a.authenticate(cloud.signJwt({ ...claims, exp: now - 30 })),
    ).not.toBeNull();

    const [head, body] = member.split(".");
    const forged = `${head}.${body}.${Buffer.alloc(64).toString("base64url")}`;
    expect(await a.authenticate(forged)).toBeNull();
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "k" })).toString("base64url")}.${body}.x`;
    expect(await a.authenticate(none)).toBeNull();
    const hs = `${Buffer.from(JSON.stringify({ alg: "HS256", kid: "k" })).toString("base64url")}.${body}.eA`;
    expect(await a.authenticate(hs)).toBeNull();
  });

  it("refetches the JWKS on an unknown kid, at most once per 30 s", async () => {
    const a = auth();
    expect(await a.authenticate(cloud.consoleToken(WS))).not.toBeNull();
    const fetches = () => cloud.callsTo("/api/auth/jwks").length;
    const before = fetches();

    cloud.rotateSigningKey();
    clock.advanceSeconds(31);
    expect(await a.authenticate(cloud.consoleToken(WS))).not.toBeNull();
    expect(fetches()).toBe(before + 1);

    // A burst of unknown kids does not hammer the endpoint.
    const unknown = cloud.signJwt(
      { sub: "user:u", ws: WS, org: "o", role: "admin" },
      "nope",
    );
    expect(await a.authenticate(unknown)).toBeNull();
    expect(await a.authenticate(unknown)).toBeNull();
    expect(fetches()).toBe(before + 1);
  });

  it("answers 503 when the JWKS cannot be fetched and none is cached", async () => {
    const a = createJwtVerifier({
      jwksUrl: "http://127.0.0.1:9/jwks.json",
      issuer: cloud.issuer,
      audience: "training",
      clock,
      timeoutMs: 500,
    });
    await expectApiError(
      a.verify(cloud.consoleToken(WS)),
      503,
      "auth_unavailable",
    );
  });

  it("accepts ES256 and RS256 keys, and only for the algorithm their key type allows", async () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwks = {
      keys: [
        { ...ec.publicKey.export({ format: "jwk" }), kid: "ec", alg: "ES256" },
        { ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa" },
      ],
    };
    const verifier = createJwtVerifier({
      jwksUrl: "https://cloud.example/jwks.json",
      issuer: "https://cloud.example",
      audience: "training",
      clock,
      fetchImpl: async () =>
        new Response(JSON.stringify(jwks), {
          headers: { "Content-Type": "application/json" },
        }),
    });
    const now = Math.floor(clock.now().getTime() / 1000);
    const token = (
      alg: string,
      kid: string,
      signer: (data: Buffer) => Buffer,
    ) => {
      const head = Buffer.from(JSON.stringify({ alg, kid })).toString(
        "base64url",
      );
      const body = Buffer.from(
        JSON.stringify({
          iss: "https://cloud.example",
          aud: ["training"],
          sub: "user:u",
          exp: now + 60,
        }),
      ).toString("base64url");

      return `${head}.${body}.${signer(Buffer.from(`${head}.${body}`)).toString("base64url")}`;
    };
    const es = (data: Buffer) =>
      sign("sha256", data, { key: ec.privateKey, dsaEncoding: "ieee-p1363" });
    const rs = (data: Buffer) => sign("sha256", data, rsa.privateKey);

    expect(await verifier.verify(token("ES256", "ec", es))).toMatchObject({
      sub: "user:u",
    });
    expect(await verifier.verify(token("RS256", "rsa", rs))).toMatchObject({
      sub: "user:u",
    });
    // The header's alg must be the key's.
    expect(await verifier.verify(token("RS256", "ec", es))).toBeNull();
    expect(await verifier.verify(token("ES256", "rsa", rs))).toBeNull();
  });

  it("authenticates the public API in AUTH_MODE=cloud, by scope", async () => {
    await cloud.addKey("grad_member_http", {
      workspace_id: WS,
      role: "member",
    });
    const t = await makeTestApp({ auth: auth(), clock });
    try {
      expect(
        (await t.json("/v1/runs", { token: "grad_member_http" })).status,
      ).toBe(200);
      expect(
        (await t.json("/v1/runs", { token: cloud.consoleToken(WS, "member") }))
          .status,
      ).toBe(200);
      const secret = await t.json("/v1/secrets", {
        token: "grad_member_http",
      });
      expect(secret.status).toBe(403);
      expect((await t.json("/v1/runs", { token: "grad_nope" })).status).toBe(
        401,
      );
    } finally {
      await t.close();
    }
  });
});
