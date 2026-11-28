import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalApiKeyAuth,
  findKeyByToken,
  hashApiKey,
  matchStaticWorkerKey,
  type AuthPrincipal,
} from "../src/adapters.js";
import { parseServerEnvironment } from "../src/environment.js";
import { ApiError } from "../src/errors.js";
import { metrics } from "../src/telemetry/metrics.js";
import type {
  WorkerTokenRecord,
  WorkerTokenRepository,
} from "../src/store/types.js";
import { buildWorkerAuthenticator } from "../src/worker-auth/index.js";
import {
  createKubernetesWorkerAuth,
  inClusterTokenReviewer,
  type TokenReviewStatus,
} from "../src/worker-auth/kubernetes.js";
import {
  createLeaseWorkerAuth,
  LEASE_TOKEN_PREFIX,
  newLeaseToken,
} from "../src/worker-auth/lease.js";
import {
  assertClaimAllowed,
  authenticateWorkerFirst,
  chainWorkerAuthenticators,
  claimGpuMemoryGb,
  toAuthPrincipal,
  workerIdMatchesHost,
  type WorkerAuthenticator,
} from "../src/worker-auth/principal.js";
import { workerTokenSource } from "../src/worker-auth/token-source.js";
import { createWorkerClient } from "../src/worker/client.js";
import { ManualClock } from "./fixtures/clock.js";

/** A projected-token-shaped JWT (aud grad, the train pool's account) with `payload` on top. */
const jwt = (payload: Record<string, unknown>): string =>
  [
    Buffer.from('{"alg":"RS256"}').toString("base64url"),
    Buffer.from(
      JSON.stringify({
        aud: ["grad"],
        sub: "system:serviceaccount:grad:grad-train-worker",
        ...payload,
      }),
    ).toString("base64url"),
    "c2lnbmF0dXJl",
  ].join(".");

const expectApiError = async (p: Promise<unknown>, status: number) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
};

describe("static worker keys", () => {
  const keys = [
    { label: "gpu", sha256: hashApiKey("k-gpu"), kinds: ["train"] as const },
    { label: "cpu", sha256: hashApiKey("k-cpu"), kinds: ["import"] as const },
  ];

  it("resolves a key to its kinds and identity", () => {
    expect(matchStaticWorkerKey("k-gpu", keys)).toEqual({
      mode: "static",
      kinds: ["train"],
      identity: "trainer-worker:gpu",
    });
    expect(matchStaticWorkerKey("k-nope", keys)).toBeNull();
  });

  it("compares against every key, even after a match (constant time)", () => {
    let reads = 0;
    const counted = keys.map((k) => ({
      ...k,
      get sha256() {
        reads += 1;
        return k.sha256;
      },
    }));
    expect(findKeyByToken("k-gpu", counted)?.label).toBe("gpu");
    expect(reads).toBe(2);
    reads = 0;
    expect(findKeyByToken("k-nope", counted)).toBeNull();
    expect(reads).toBe(2);
  });

  it("a wrong-kind static key gets no claimable kinds", async () => {
    const auth = createLocalApiKeyAuth({
      trainerKeys: keys,
      lookup: { findActiveByHash: async () => null },
    });
    expect((await auth.authenticate("k-cpu"))?.workerKinds).toEqual(["import"]);
  });
});

describe("kubernetes service-account tokens", () => {
  const clock = new ManualClock();
  const nowSec = () => Math.floor(clock.now().getTime() / 1000);
  const accounts = {
    "grad/grad-train-worker": ["train"] as const,
    "grad/grad-import-worker": ["import"] as const,
  };
  const ok = (sa: string, extra = {}): TokenReviewStatus => ({
    authenticated: true,
    user: {
      username: `system:serviceaccount:${sa.replace("/", ":")}`,
      extra: {
        "authentication.kubernetes.io/pod-name": ["train-0"],
        ...extra,
      },
    },
    audiences: ["grad"],
  });
  const make = (review: (token: string) => Promise<TokenReviewStatus>) => {
    const spy = vi.fn(review);
    const auth = createKubernetesWorkerAuth({
      serviceAccounts: accounts,
      review: (token, audiences) => {
        expect(audiences).toEqual(["grad"]);
        return spy(token);
      },
      clock,
    });
    return { auth, spy };
  };

  it("maps a reviewed service account to its kinds", async () => {
    const { auth } = make(async () => ok("grad/grad-train-worker"));
    const token = jwt({ exp: nowSec() + 3600 });
    const principal = await auth.authenticate(token);
    expect(principal).toMatchObject({
      kinds: ["train"],
      identity: "k8s:grad/grad-train-worker/train-0",
    });
    expect(principal?.expiresAt?.getTime()).toBe((nowSec() + 3600) * 1000);
    expect(principal?.host).toBeUndefined();
  });

  it("rejects unmapped accounts, non-service-account users, other audiences and failed reviews", async () => {
    for (const status of [
      ok("grad/someone-else"),
      ok("other/grad-train-worker"),
      { ...ok("grad/grad-train-worker"), audiences: ["https://kubernetes"] },
      { ...ok("grad/grad-train-worker"), audiences: undefined },
      {
        authenticated: true,
        user: { username: "alice" },
        audiences: ["grad"],
      },
      { authenticated: false, error: "token has expired" },
      {},
    ] as TokenReviewStatus[]) {
      const { auth } = make(async () => status);
      expect(await auth.authenticate(jwt({ exp: nowSec() + 60 }))).toBeNull();
    }
  });

  it("never sends non-JWT tokens (static keys, lease tokens) to the API server", async () => {
    const { auth, spy } = make(async () => ok("grad/grad-train-worker"));
    for (const token of ["grad_abc", newLeaseToken(), "a.b", "x".repeat(10)]) {
      expect(await auth.authenticate(token)).toBeNull();
    }
    expect(await auth.authenticate(`${"a".repeat(16_400)}.b.c`)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the API server is unreachable", async () => {
    const { auth } = make(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await expectApiError(auth.authenticate(jwt({ exp: nowSec() + 60 })), 503);
  });

  it("caches positive reviews for at most 60 s", async () => {
    const { auth, spy } = make(async () => ok("grad/grad-train-worker"));
    const token = jwt({ exp: nowSec() + 3600 });
    await auth.authenticate(token);
    clock.advanceSeconds(59);
    await auth.authenticate(token);
    expect(spy).toHaveBeenCalledTimes(1);
    clock.advanceSeconds(2);
    await auth.authenticate(token);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never caches past the token's exp", async () => {
    const { auth, spy } = make(async () => ok("grad/grad-train-worker"));
    const short = jwt({ exp: nowSec() + 10 });
    await auth.authenticate(short);
    clock.advanceSeconds(9);
    await auth.authenticate(short);
    expect(spy).toHaveBeenCalledTimes(1);
    // Past its exp the token is not even sent for review.
    clock.advanceSeconds(2);
    expect(await auth.authenticate(short)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("only sends tokens that claim audience grad, a mapped account and a future exp", async () => {
    const { auth, spy } = make(async () => ok("grad/grad-train-worker"));
    const exp = nowSec() + 600;
    for (const token of [
      jwt({}),
      jwt({ exp: nowSec() - 1 }),
      jwt({ exp: String(exp) }),
      jwt({ exp, aud: ["https://kubernetes.default.svc"] }),
      jwt({ exp, aud: "grad-other" }),
      jwt({ exp, sub: "system:serviceaccount:grad:someone-else" }),
      jwt({ exp, sub: "alice" }),
      jwt({ exp, sub: undefined }),
      "eyJhbGciOiJSUzI1NiJ9.bm90LWpzb24.c2ln",
      `eyJhbGciOiJSUzI1NiJ9.${Buffer.from("null").toString("base64url")}.c2ln`,
    ]) {
      expect(await auth.authenticate(token)).toBeNull();
    }
    expect(spy).not.toHaveBeenCalled();
    // A string audience is fine, as the API server may issue one.
    expect(await auth.authenticate(jwt({ exp, aud: "grad" }))).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("counts reviews by result, their latency and cache hits", async () => {
    const reviews = async (result: string) =>
      (await metrics.tokenReviews.get()).values.find(
        (v) => v.labels.result === result,
      )?.value ?? 0;
    const cache = async (result: string) =>
      (await metrics.authCache.get()).values.find(
        (v) =>
          (v.labels as Record<string, unknown>).mode === "kubernetes" &&
          (v.labels as Record<string, unknown>).result === result,
      )?.value ?? 0;
    const before = {
      authenticated: await reviews("authenticated"),
      rejected: await reviews("rejected"),
      error: await reviews("error"),
      hit: await cache("hit"),
      miss: await cache("miss"),
      timed:
        (await metrics.tokenReviewDuration.get()).values.find(
          (v) => v.metricName === "grad_token_review_duration_seconds_count",
        )?.value ?? 0,
    };
    let answer: () => Promise<TokenReviewStatus> = async () =>
      ok("grad/grad-train-worker");
    const { auth } = make(() => answer());
    const token = jwt({ exp: nowSec() + 3600 });
    expect(await auth.authenticate(token)).not.toBeNull();
    expect(await auth.authenticate(token)).not.toBeNull(); // cached
    answer = async () => ({ authenticated: false });
    expect(
      await auth.authenticate(jwt({ exp: nowSec() + 3600, i: 2 })),
    ).toBeNull();
    answer = async () => {
      throw new Error("connection refused");
    };
    await expectApiError(
      auth.authenticate(jwt({ exp: nowSec() + 3600, i: 3 })),
      503,
    );
    expect(await reviews("authenticated")).toBe(before.authenticated + 1);
    expect(await reviews("rejected")).toBe(before.rejected + 1);
    expect(await reviews("error")).toBe(before.error + 1);
    expect(await cache("hit")).toBe(before.hit + 1);
    expect(await cache("miss")).toBe(before.miss + 3);
    expect(
      (await metrics.tokenReviewDuration.get()).values.find(
        (v) => v.metricName === "grad_token_review_duration_seconds_count",
      )?.value,
    ).toBe(before.timed + 3);
    expect((await metrics.tokenReviewsInFlight.get()).values[0]?.value).toBe(0);
  });

  it("answers 503 past maxInFlight concurrent reviews, and recovers", async () => {
    const pending: Array<() => void> = [];
    const spy = vi.fn(
      () =>
        new Promise<TokenReviewStatus>((resolve) => {
          pending.push(() => resolve(ok("grad/grad-train-worker")));
        }),
    );
    const auth = createKubernetesWorkerAuth({
      serviceAccounts: accounts,
      review: spy,
      clock,
      maxInFlight: 2,
    });
    const exp = nowSec() + 600;
    const first = auth.authenticate(jwt({ exp, i: 1 }));
    const second = auth.authenticate(jwt({ exp, i: 2 }));
    const saturated = async () =>
      (await metrics.tokenReviews.get()).values.find(
        (v) => v.labels.result === "saturated",
      )?.value ?? 0;
    const beforeSaturated = await saturated();
    await expectApiError(auth.authenticate(jwt({ exp, i: 3 })), 503);
    expect(await saturated()).toBe(beforeSaturated + 1);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const done of pending.splice(0)) done();
    expect(await first).not.toBeNull();
    expect(await second).not.toBeNull();
    const third = auth.authenticate(jwt({ exp, i: 3 }));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.();
    expect(await third).not.toBeNull();
  });

  it("does not cache rejections and bounds the cache", async () => {
    let status = ok("grad/someone-else");
    const spy = vi.fn(async () => status);
    const auth = createKubernetesWorkerAuth({
      serviceAccounts: accounts,
      review: spy,
      clock,
      maxCacheEntries: 2,
    });
    const token = jwt({ exp: nowSec() + 600 });
    expect(await auth.authenticate(token)).toBeNull();
    status = ok("grad/grad-import-worker", {
      "authentication.kubernetes.io/pod-name": [],
    });
    expect(await auth.authenticate(token)).toMatchObject({
      kinds: ["import"],
      identity: "k8s:grad/grad-import-worker",
    });
    for (const i of [1, 2, 3]) {
      await auth.authenticate(jwt({ exp: nowSec() + 600, i }));
    }
    // The first token was evicted (oldest), so it is reviewed again.
    await auth.authenticate(token);
    expect(spy).toHaveBeenCalledTimes(6);
  });
});

describe("the in-cluster TokenReview client", () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  const serve = async (
    handler: (body: unknown, auth: string | undefined) => [number, unknown],
  ) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const [status, body] = handler(
          JSON.parse(Buffer.concat(chunks).toString()),
          req.headers.authorization,
        );
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };

  const ownToken = () => {
    const dir = mkdtempSync(join(tmpdir(), "grad-sa-"));
    writeFileSync(join(dir, "token"), "own-sa-token\n");
    return join(dir, "token");
  };

  it("posts a TokenReview with the pod's own token and returns its status", async () => {
    let seen: unknown = null;
    const baseUrl = await serve((body, auth) => {
      seen = { body, auth };
      return [201, { status: { authenticated: true, audiences: ["grad"] } }];
    });
    const review = inClusterTokenReviewer({ baseUrl, tokenPath: ownToken() });
    expect(await review("worker.jwt.token", ["grad"])).toEqual({
      authenticated: true,
      audiences: ["grad"],
    });
    expect(seen).toEqual({
      auth: "Bearer own-sa-token",
      body: {
        apiVersion: "authentication.k8s.io/v1",
        kind: "TokenReview",
        spec: { token: "worker.jwt.token", audiences: ["grad"] },
      },
    });
  });

  it("throws on an API error, a timeout or outside a cluster", async () => {
    const baseUrl = await serve(() => [403, { message: "forbidden" }]);
    await expect(
      inClusterTokenReviewer({ baseUrl, tokenPath: ownToken() })("t", ["grad"]),
    ).rejects.toThrow(/HTTP 403/);
    await expect(
      inClusterTokenReviewer({ env: {} })("t", ["grad"]),
    ).rejects.toThrow(/KUBERNETES_SERVICE_HOST/);
    await expect(
      inClusterTokenReviewer({
        env: {
          KUBERNETES_SERVICE_HOST: "127.0.0.1",
          KUBERNETES_SERVICE_PORT: "1",
        },
        tokenPath: ownToken(),
        caPath: "/nonexistent",
      })("t", ["grad"]),
    ).rejects.toThrow();
    const hang = createServer(() => undefined);
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    try {
      await expect(
        inClusterTokenReviewer({
          baseUrl: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`,
          tokenPath: ownToken(),
          timeoutMs: 50,
        })("t", ["grad"]),
      ).rejects.toThrow(/timed out/);
    } finally {
      hang.closeAllConnections();
      hang.close();
    }
  });
});

const memoryTokens = (): WorkerTokenRepository & {
  rows: Map<string, WorkerTokenRecord>;
} => {
  const rows = new Map<string, WorkerTokenRecord>();
  return {
    rows,
    create: async ({ tokenSha256, now: _now, ...row }) => {
      rows.set(tokenSha256, { ...row, revokedAt: null });
    },
    findByHash: async (hash) => rows.get(hash) ?? null,
    revokeLease: async (leaseId, createdBy, now) => {
      let n = 0;
      for (const row of rows.values()) {
        if (
          row.leaseId === leaseId &&
          row.createdBy === createdBy &&
          !row.revokedAt
        ) {
          row.revokedAt = now;
          n += 1;
        }
      }
      return n;
    },
    deleteExpired: async (now) => {
      let n = 0;
      for (const [k, row] of rows) {
        if (row.expiresAt < now) {
          rows.delete(k);
          n += 1;
        }
      }
      return n;
    },
  };
};

describe("lease tokens", () => {
  const clock = new ManualClock();
  const setup = async (gpuMemoryGb: number | null = 80) => {
    const tokens = memoryTokens();
    const token = newLeaseToken();
    await tokens.create({
      tokenSha256: hashApiKey(token),
      hostId: "host-a",
      leaseId: "lease-1",
      kinds: ["train"],
      gpuMemoryGb,
      expiresAt: new Date(clock.now().getTime() + 3_600_000),
      createdBy: "orchestrator:fleet",
      now: clock.now(),
    });
    return { tokens, token, auth: createLeaseWorkerAuth({ tokens, clock }) };
  };

  it("mints 256-bit prefixed tokens", () => {
    const token = newLeaseToken();
    expect(token.startsWith(LEASE_TOKEN_PREFIX)).toBe(true);
    expect(
      Buffer.from(token.slice(LEASE_TOKEN_PREFIX.length), "base64url"),
    ).toHaveLength(32);
    expect(newLeaseToken()).not.toBe(token);
  });

  it("resolves a valid token to its host, lease, kinds and GPU bound", async () => {
    const { auth, token } = await setup();
    expect(await auth.authenticate(token)).toMatchObject({
      kinds: ["train"],
      identity: "lease:fleet/host-a/lease-1",
      host: "host-a",
      lease: "lease-1",
      gpuMemoryGb: 80,
    });
    expect(await auth.authenticate("gradwt_unknown")).toBeNull();
    expect(await auth.authenticate("grad_not_a_lease_token")).toBeNull();
  });

  it("rejects expired and revoked tokens", async () => {
    const expired = await setup();
    clock.advanceSeconds(3600);
    expect(await expired.auth.authenticate(expired.token)).toBeNull();
    clock.advanceSeconds(-3600);

    const revoked = await setup();
    expect(
      await revoked.tokens.revokeLease(
        "lease-1",
        "orchestrator:other",
        clock.now(),
      ),
    ).toBe(0);
    expect(await revoked.auth.authenticate(revoked.token)).not.toBeNull();
    await revoked.tokens.revokeLease(
      "lease-1",
      "orchestrator:fleet",
      clock.now(),
    );
    expect(await revoked.auth.authenticate(revoked.token)).toBeNull();
  });

  it("binds the claim to the host and bounds the GPU memory", async () => {
    const { auth, token } = await setup();
    const principal = toAuthPrincipal((await auth.authenticate(token))!);
    expect(() =>
      assertClaimAllowed(principal, { worker_id: "host-a-3fa9c1" }),
    ).not.toThrow();
    expect(() =>
      assertClaimAllowed(principal, {
        worker_id: "host-a",
        gpu: { memory_gb: 80 },
      }),
    ).not.toThrow();
    for (const workerId of ["host-b", "host-a-b-123", "host-ab", "x-host-a"]) {
      expect(() =>
        assertClaimAllowed(principal, { worker_id: workerId }),
      ).toThrow(/bound to host 'host-a'/);
    }
    expect(() =>
      assertClaimAllowed(principal, {
        worker_id: "host-a",
        gpu: { memory_gb: 141 },
      }),
    ).toThrow(/at most 80 GB/);

    expect(claimGpuMemoryGb(principal, 40)).toBe(40);
    expect(claimGpuMemoryGb(principal, 141)).toBe(80);
    expect(claimGpuMemoryGb(principal, undefined)).toBe(80);
    const unbound = toAuthPrincipal({
      mode: "static",
      kinds: ["train"],
      identity: "x",
    });
    expect(claimGpuMemoryGb(unbound, 24)).toBe(24);
    expect(claimGpuMemoryGb(unbound, undefined)).toBeNull();
    expect(() =>
      assertClaimAllowed(unbound, {
        worker_id: "anything",
        gpu: { memory_gb: 999 },
      }),
    ).not.toThrow();
  });

  it("matches worker ids to hosts exactly", () => {
    expect(workerIdMatchesHost("h1", "h1")).toBe(true);
    expect(workerIdMatchesHost("h1-abc123", "h1")).toBe(true);
    expect(workerIdMatchesHost("h1-", "h1")).toBe(false);
    expect(workerIdMatchesHost(`h1-${"a".repeat(33)}`, "h1")).toBe(false);
    expect(workerIdMatchesHost("h1:x", "h1")).toBe(false);
  });
});

describe("the authenticator chain", () => {
  const fixed = (
    mode: WorkerAuthenticator["mode"],
    result: "match" | "none" | "throw",
  ): WorkerAuthenticator => ({
    mode,
    authenticate: async () => {
      if (result === "throw") throw new ApiError(503, "down", "Down", "down");
      return result === "match"
        ? { mode, kinds: ["train"], identity: mode }
        : null;
    },
  });

  it("takes the first match, survives an undecided authenticator, and fails closed", async () => {
    const chain = (...a: WorkerAuthenticator[]) => chainWorkerAuthenticators(a);
    expect(
      (
        await chain(
          fixed("static", "match"),
          fixed("lease", "match"),
        ).authenticate("t")
      )?.identity,
    ).toBe("static");
    expect(
      (
        await chain(
          fixed("kubernetes", "throw"),
          fixed("lease", "match"),
        ).authenticate("t")
      )?.identity,
    ).toBe("lease");
    expect(await chain(fixed("static", "none")).authenticate("t")).toBeNull();
    await expectApiError(
      chain(fixed("kubernetes", "throw"), fixed("lease", "none")).authenticate(
        "t",
      ),
      503,
    );
    expect(chain().mode).toBe("static");
  });

  it("an outage answers 503, not 401, unless a workspace key matches", async () => {
    const down = fixed("kubernetes", "throw");
    const workspace: AuthPrincipal = {
      kind: "workspace",
      workspaceId: "w",
      actor: "key:x",
      scopes: ["admin"],
    };
    await expectApiError(
      authenticateWorkerFirst(down, "t", async () => null),
      503,
    );
    expect(
      await authenticateWorkerFirst(down, "t", async () => workspace),
    ).toBe(workspace);
    expect(
      await authenticateWorkerFirst(
        fixed("static", "none"),
        "t",
        async () => null,
      ),
    ).toBeNull();
  });

  it("builds the configured modes in order", async () => {
    const tokens = memoryTokens();
    const review = vi.fn(async () => ({}));
    const clock = new ManualClock();
    const chain = buildWorkerAuthenticator(
      {
        modes: ["kubernetes", "static", "lease"],
        serviceAccounts: { "grad/grad-train-worker": ["train"] },
      },
      {
        staticKeys: [
          { label: "s", sha256: hashApiKey("k-static"), kinds: ["train"] },
        ],
        tokens,
        clock,
        review,
      },
    );
    expect(chain.mode).toBe("kubernetes");
    expect((await chain.authenticate("k-static"))?.identity).toBe(
      "trainer-worker:s",
    );
    expect(
      await chain.authenticate(
        jwt({ exp: Math.floor(clock.now().getTime() / 1000) + 60 }),
      ),
    ).toBeNull();
    expect(review).toHaveBeenCalledTimes(1);
  });
});

describe("worker-auth configuration", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    S3_BUCKET: "grad",
    AUTH_MODE: "none",
  };
  const orch = JSON.stringify([
    { label: "fleet", sha256: hashApiKey("o"), kinds: ["train"] },
  ]);
  const sa = JSON.stringify({ "grad/grad-train-worker": ["train"] });

  it("defaults to static and parses every mode", () => {
    expect(parseServerEnvironment(base).workerAuth).toEqual({
      modes: ["static"],
      serviceAccounts: {},
      orchestratorKeys: [],
      internalPort: undefined,
    });
    const env = parseServerEnvironment({
      ...base,
      GRAD_WORKER_AUTH: "kubernetes, lease",
      GRAD_WORKER_K8S_SERVICE_ACCOUNTS: sa,
      GRAD_ORCHESTRATOR_KEYS_JSON: orch,
      INTERNAL_PORT: "8790",
      TRAINER_KEYS_JSON: JSON.stringify([
        { label: "a", sha256: hashApiKey("a"), kinds: ["train"] },
      ]),
    });
    expect(env.workerAuth.modes).toEqual(["kubernetes", "lease"]);
    expect(env.workerAuth.serviceAccounts).toEqual({
      "grad/grad-train-worker": ["train"],
    });
    expect(env.workerAuth.internalPort).toBe(8790);
    expect(env.warnings.join("\n")).toMatch(/TRAINER_KEYS_JSON .* are ignored/);
  });

  it("refuses unsafe or useless combinations", () => {
    for (const [extra, message] of [
      [{ GRAD_WORKER_AUTH: "magic" }, /unknown mode 'magic'/],
      [{ GRAD_WORKER_AUTH: " , " }, /at least one/],
      [{ GRAD_WORKER_AUTH: "static,static" }, /twice/],
      [
        { GRAD_WORKER_AUTH: "kubernetes" },
        /needs GRAD_WORKER_K8S_SERVICE_ACCOUNTS/,
      ],
      [
        {
          GRAD_WORKER_AUTH: "kubernetes",
          GRAD_WORKER_K8S_SERVICE_ACCOUNTS: "{",
        },
        /must be JSON/,
      ],
      [
        {
          GRAD_WORKER_AUTH: "kubernetes",
          GRAD_WORKER_K8S_SERVICE_ACCOUNTS: '{"Bad Name":["train"]}',
        },
        /namespace/,
      ],
      [
        {
          GRAD_WORKER_AUTH: "kubernetes",
          GRAD_WORKER_K8S_SERVICE_ACCOUNTS: '{"grad/x":["deploy"]}',
        },
        /Invalid GRAD_WORKER_K8S_SERVICE_ACCOUNTS/,
      ],
      [{ INTERNAL_PORT: "8790" }, /INTERNAL_PORT would serve nothing/],
      [
        { GRAD_WORKER_AUTH: "lease", INTERNAL_PORT: "8790" },
        /INTERNAL_PORT would serve nothing/,
      ],
      [
        { GRAD_ORCHESTRATOR_KEYS_JSON: orch, INTERNAL_PORT: "8790" },
        /INTERNAL_PORT would serve nothing/,
      ],
      [
        {
          GRAD_WORKER_AUTH: "lease",
          INTERNAL_PORT: "8787",
          GRAD_ORCHESTRATOR_KEYS_JSON: orch,
        },
        /must differ/,
      ],
      [
        {
          GRAD_ORCHESTRATOR_KEYS_JSON: JSON.stringify([
            { label: "a", sha256: hashApiKey("1"), kinds: ["train"] },
            { label: "a", sha256: hashApiKey("2"), kinds: ["train"] },
          ]),
        },
        /two keys labelled 'a'/,
      ],
    ] as const) {
      expect(() => parseServerEnvironment({ ...base, ...extra })).toThrow(
        message,
      );
    }
  });

  it("INTERNAL_PORT starts with either route group: Cloud routes alone need no lease auth", () => {
    const cloud = parseServerEnvironment({
      ...base,
      AUTH_MODE: "cloud",
      GRAD_CLOUD_AUTH_DATABASE_URL: "postgres://view",
      GRAD_CLOUD_JWKS_URL: "https://api.gradiated.com/api/auth/jwks",
      GRAD_CLOUD_JWT_ISSUER: "https://api.gradiated.com",
      GRAD_WORKER_AUTH: "kubernetes",
      GRAD_WORKER_K8S_SERVICE_ACCOUNTS: sa,
      INTERNAL_PORT: "8788",
    });
    expect(cloud.workerAuth).toMatchObject({
      internalPort: 8788,
      orchestratorKeys: [],
    });
    const lease = parseServerEnvironment({
      ...base,
      GRAD_WORKER_AUTH: "lease",
      INTERNAL_PORT: "8788",
      GRAD_ORCHESTRATOR_KEYS_JSON: orch,
    });
    expect(lease.workerAuth.orchestratorKeys).toHaveLength(1);
    // Lease enabled without a key on a Cloud listener: up, minting off.
    const noKeys = parseServerEnvironment({
      ...base,
      AUTH_MODE: "cloud",
      GRAD_CLOUD_AUTH_DATABASE_URL: "postgres://view",
      GRAD_CLOUD_JWKS_URL: "https://api.gradiated.com/api/auth/jwks",
      GRAD_CLOUD_JWT_ISSUER: "https://api.gradiated.com",
      GRAD_WORKER_AUTH: "static,lease",
      INTERNAL_PORT: "8788",
    });
    expect(noKeys.warnings.join("\n")).toMatch(/serves no lease-token routes/);
  });

  it("warns about settings a mode does not use", () => {
    const env = parseServerEnvironment({
      ...base,
      GRAD_WORKER_AUTH: "static,lease",
      GRAD_WORKER_K8S_SERVICE_ACCOUNTS: sa,
      GRAD_ORCHESTRATOR_KEYS_JSON: orch,
    });
    const warnings = env.warnings.join("\n");
    expect(warnings).toMatch(/K8S_SERVICE_ACCOUNTS is ignored/);
    expect(warnings).toMatch(/ORCHESTRATOR_KEYS_JSON is ignored/);
    expect(warnings).toMatch(/cannot mint them/);
    expect(
      parseServerEnvironment({ ...base, GRAD_ORCHESTRATOR_KEYS_JSON: orch })
        .warnings,
    ).toContain(
      "GRAD_ORCHESTRATOR_KEYS_JSON is ignored: GRAD_WORKER_AUTH does not include lease.",
    );
  });
});

describe("the TypeScript worker's token source", () => {
  it("prefers GRAD_WORKER_TOKEN, re-reads GRAD_WORKER_TOKEN_FILE, falls back to TRAINER_API_KEY", () => {
    const dir = mkdtempSync(join(tmpdir(), "grad-wt-"));
    const path = join(dir, "token");
    writeFileSync(path, "one\n");
    expect(
      workerTokenSource({
        GRAD_WORKER_TOKEN: " fixed ",
        GRAD_WORKER_TOKEN_FILE: path,
      })(),
    ).toBe("fixed");
    const fromFile = workerTokenSource({
      GRAD_WORKER_TOKEN_FILE: path,
      TRAINER_API_KEY: "static",
    });
    expect(fromFile()).toBe("one");
    writeFileSync(path, "two");
    expect(fromFile()).toBe("two");
    expect(
      workerTokenSource({ GRAD_WORKER_TOKEN_FILE: join(dir, "absent") })(),
    ).toBeUndefined();
    expect(workerTokenSource({ TRAINER_API_KEY: "static" })()).toBe("static");
    expect(workerTokenSource({})()).toBeUndefined();
  });
});

describe("the eval worker's client", () => {
  it("reads its token source on every request", async () => {
    const seen: Array<string | null> = [];
    const tokens = ["tok-1", "tok-2", undefined];
    const client = createWorkerClient({
      serverUrl: "http://grad.test",
      apiKey: () => tokens.shift(),
      workerId: "w",
      retryDelaysMs: [],
      fetch: async (_url, init) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify({ protocol: "x", job: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    for (let i = 0; i < 3; i += 1) await client.claim(["eval"], 30);
    expect(seen).toEqual(["Bearer tok-1", "Bearer tok-2", null]);
  });
});
