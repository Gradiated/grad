import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import pg from "pg";

/**
 * Test double for Gradiated Cloud, the product side of every contract in
 * docs/CLOUD_MODE.md, as real servers so grad's Cloud adapters run unmodified:
 *
 * - the auth view: `auth_principals_v1` in a throwaway Postgres schema
 *   (`authDatabaseUrl`), filled with `addKey`;
 * - the control plane's JWKS (Ed25519) and signed console and service JWTs;
 * - billing on the internal listener: the price list (ETag), the balance
 *   check and usage-event ingest (deduplicated by event_id, amounts checked);
 * - the inference gateway's chat completions (eval lane headers recorded,
 *   proxied to an OpenAI-compatible upstream) and eval-only Versions;
 * - `training/traces:pull` for the `gradiated` source.
 *
 * `/_control/*` routes drive it from any language (keys, tokens, balances,
 * gateway records).
 */

export interface FakeKey {
  workspace_id: string;
  role?: "admin" | "member";
  status?: "active" | "suspended";
  scopes?: string[] | null;
  organization_slug?: string;
  expires_at?: Date | null;
}

export interface FakeUsageEvent {
  event_id: string;
  workspace_id: string;
  product: string;
  sku: string;
  quantity: number;
  amount_nano_usd: number;
  price_version: string;
  occurred_at: string;
  subject_id: string;
  tags: Record<string, string>;
}

export interface GatewayCall {
  model: string;
  workspace: string | null;
  source: string | null;
  eval_id: string | null;
}

export interface LoggedRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export interface FakeCloudApi {
  url: string;
  /** The bearer grad sends to the internal listener (CLOUD_SERVICE_TOKEN). */
  serviceToken: string;
  /** GRAD_CLOUD_JWKS_URL / GRAD_CLOUD_JWT_ISSUER. */
  jwksUrl: string;
  issuer: string;
  /** GRAD_CLOUD_BILLING_URL / GRAD_CLOUD_PRICES_URL. */
  billingUrl: string;
  pricesUrl: string;
  /** GRAD_CLOUD_GATEWAY_URL / GRAD_CLOUD_GATEWAY_TOKEN. */
  gatewayUrl: string;
  gatewayToken: string;
  /** GRAD_CLOUD_AUTH_DATABASE_URL (null without `databaseUrl`). */
  authDatabaseUrl: string | null;
  /** Adds (or replaces) an API key in the auth view. */
  addKey(token: string, key: FakeKey): Promise<void>;
  /** Removes it from the view (revoked, member removed, org suspended...). */
  removeKey(token: string): Promise<void>;
  /** Signs a JWT with the current signing key (EdDSA). */
  signJwt(claims: Record<string, unknown>, kid?: string): string;
  /** A console token: a member of `workspace` with `role`. */
  consoleToken(
    workspace: string,
    role?: "admin" | "member",
    extra?: Record<string, unknown>,
  ): string;
  /** A service token for grad's internal listener. */
  serviceJwt(workspace: string, scopes: string[]): string;
  /** Adds a signing key (the JWKS keeps the previous one); returns its kid. */
  rotateSigningKey(): string;
  /** workspace → remaining balance in nano-USD; missing: unlimited. */
  balances: Map<string, number>;
  /** Workspaces billing answers `suspended` for. */
  suspended: Set<string>;
  /** Accepted usage events, deduplicated by event_id. */
  usageEvents: FakeUsageEvent[];
  /** Publishes a new price list version (old ones stay valid for ingest). */
  setPrices(version: string, skus: Record<string, number>): void;
  gatewayCalls: GatewayCall[];
  /** Eval-only Versions published for grad (`training/eval-versions`). */
  evalVersions: Array<{
    workspace_id: string;
    artifact_id: string;
    model: string;
  }>;
  /** workspace → gateway trace and score rows (training/traces:pull). */
  gatewayRecords: Map<string, Record<string, unknown>[]>;
  requests: LoggedRequest[];
  /** The next `count` requests to `path` (or any internal path) return HTTP `status`. */
  failNext(count: number, status?: number, path?: string): void;
  /** Delay every internal response by `ms`. */
  setLatency(ms: number): void;
  /** Override the JSON body returned for the next request to `path`. */
  respondOnce(path: string, status: number, body: unknown): void;
  callsTo(path: string): LoggedRequest[];
  close(): Promise<void>;
}

export interface FakeCloudOptions {
  serviceToken?: string;
  /** A Postgres URL: the auth view lives in a throwaway schema there. */
  databaseUrl?: string;
  /** Where gateway chat completions are forwarded (fake-openai); unset: echo. */
  gatewayUpstream?: string;
  /** The first price list: SKU → nano-USD per million tokens. */
  prices?: Record<string, number>;
  /** The clock tokens are issued on (default: the system clock). */
  clock?: { now(): Date };
}

const ORG_ID = "00000000-0000-4000-8000-00000000000a";
export const FAKE_ORG_SLUG = "acme";

const readJson = async (
  req: IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");

  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
};

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** Billing's rounding: round_half_up(quantity × price / 10^6). */
const amountOf = (quantity: number, nanoPerMtok: number): number =>
  Number((BigInt(quantity) * BigInt(nanoPerMtok) + 500_000n) / 1_000_000n);

const withSearchPath = (url: string, schema: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema}`);

  return parsed.toString();
};

const createAuthSchema = async (databaseUrl: string) => {
  const schema = `fake_product_${randomBytes(5).toString("hex")}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(
    `CREATE TABLE ${schema}.api_keys (
       digest bytea PRIMARY KEY, id uuid NOT NULL, org_id uuid NOT NULL,
       org_slug text NOT NULL, workspace_id text NOT NULL, user_id uuid NOT NULL,
       role text NOT NULL, status text NOT NULL, scopes text[], expires_at timestamptz)`,
  );
  // The product's view: only usable principals (here: every row).
  await pool.query(
    `CREATE VIEW ${schema}.auth_principals_v1 WITH (security_barrier) AS
       SELECT digest AS key_hash, id AS api_key_id, org_id, org_slug, workspace_id,
              user_id, 'key:' || id AS actor, role, status, scopes, expires_at
         FROM ${schema}.api_keys`,
  );

  return {
    url: withSearchPath(databaseUrl, schema),
    add: async (token: string, key: FakeKey) => {
      await pool.query(
        `INSERT INTO ${schema}.api_keys VALUES ($1, $2, $3, $4, $5, $6, $7, $10, $8, $9)
         ON CONFLICT (digest) DO UPDATE SET workspace_id = EXCLUDED.workspace_id,
           role = EXCLUDED.role, status = EXCLUDED.status, scopes = EXCLUDED.scopes,
           expires_at = EXCLUDED.expires_at`,
        [
          createHash("sha256").update(token).digest(),
          randomUUID(),
          ORG_ID,
          key.organization_slug ?? FAKE_ORG_SLUG,
          key.workspace_id,
          randomUUID(),
          key.role ?? "admin",
          key.scopes ?? null,
          key.expires_at ?? null,
          key.status ?? "active",
        ],
      );
    },
    remove: async (token: string) => {
      await pool.query(`DELETE FROM ${schema}.api_keys WHERE digest = $1`, [
        createHash("sha256").update(token).digest(),
      ]);
    },
    drop: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    },
  };
};

export const startFakeCloudApi = async (
  options: FakeCloudOptions = {},
): Promise<FakeCloudApi> => {
  const serviceToken = options.serviceToken ?? "svc_test_token";
  const gatewayToken = "gw_test_token";
  const auth = options.databaseUrl
    ? await createAuthSchema(options.databaseUrl)
    : null;

  const signingKeys: Array<{ kid: string; key: KeyObject; jwk: object }> = [];
  const rotateSigningKey = (): string => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const kid = `k${signingKeys.length + 1}-${randomBytes(3).toString("hex")}`;
    signingKeys.push({
      kid,
      key: privateKey,
      jwk: {
        ...publicKey.export({ format: "jwk" }),
        kid,
        alg: "EdDSA",
        use: "sig",
      },
    });
    // The JWKS holds the current and the previous key.
    if (signingKeys.length > 2) signingKeys.shift();

    return kid;
  };
  rotateSigningKey();

  const priceVersions = new Map<string, Record<string, number>>();
  let currentPrices = "pv_1";
  priceVersions.set(currentPrices, { ...(options.prices ?? {}) });

  const balances = new Map<string, number>();
  const suspended = new Set<string>();
  const usageEvents: FakeUsageEvent[] = [];
  const gatewayCalls: GatewayCall[] = [];
  const evalVersions: FakeCloudApi["evalVersions"] = [];
  const requests: LoggedRequest[] = [];
  const gatewayRecords = new Map<string, Record<string, unknown>[]>();
  const failures: Array<{ remaining: number; status: number; path?: string }> =
    [];
  const canned = new Map<string, Array<{ status: number; body: unknown }>>();
  let latencyMs = 0;
  let url = "";

  const signJwt = (claims: Record<string, unknown>, kid?: string): string => {
    const key =
      signingKeys.find((k) => k.kid === kid) ??
      (signingKeys.at(-1) as (typeof signingKeys)[number]);
    const now = Math.floor(
      (options.clock?.now().getTime() ?? Date.now()) / 1000,
    );
    // An unknown `kid` is signed with the current key but keeps its name.
    const head = b64url({ alg: "EdDSA", typ: "JWT", kid: kid ?? key.kid });
    const body = b64url({
      iss: url,
      aud: "training",
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      ...claims,
    });
    const signature = sign(null, Buffer.from(`${head}.${body}`), key.key);

    return `${head}.${body}.${signature.toString("base64url")}`;
  };
  const consoleToken: FakeCloudApi["consoleToken"] = (
    workspace,
    role = "admin",
    extra = {},
  ) =>
    signJwt({
      sub: `user:${randomUUID()}`,
      ws: workspace,
      org: ORG_ID,
      role,
      ...extra,
    });
  const serviceJwt = (workspace: string, scopes: string[]) =>
    signJwt({ sub: "service:inference", ws: workspace, org: ORG_ID, scopes });

  const ingest = (body: Record<string, unknown>): [number, unknown] => {
    const events = (
      Array.isArray(body.events) ? body.events : []
    ) as FakeUsageEvent[];
    if (events.length === 0 || events.length > 500) {
      return [422, { code: "invalid_batch", detail: "1-500 events" }];
    }
    let duplicates = 0;
    for (const event of events) {
      const price = priceVersions.get(event.price_version)?.[event.sku];
      if (
        price === undefined ||
        amountOf(event.quantity, price) !== event.amount_nano_usd
      ) {
        return [422, { code: "price_mismatch", event_id: event.event_id }];
      }
    }
    for (const event of events) {
      if (usageEvents.some((e) => e.event_id === event.event_id)) {
        duplicates += 1;
        continue;
      }
      usageEvents.push(event);
      const balance = balances.get(event.workspace_id);
      if (balance !== undefined) {
        balances.set(event.workspace_id, balance - event.amount_nano_usd);
      }
    }

    return [200, { accepted: events.length - duplicates, duplicates }];
  };

  const internal = (
    path: string,
    body: Record<string, unknown>,
  ): [number, unknown] => {
    const ws = String(body.workspace_id ?? "");
    switch (path) {
      case "/api/internal/v1/billing/check": {
        if (suspended.has(ws))
          return [200, { allowed: false, reason: "suspended" }];
        const balance = balances.get(ws);
        const estimate = Number(body.estimated_amount_nano_usd ?? 0);
        if (ws === "ws_unknown") return [404, { detail: "unknown workspace" }];
        const allowed =
          balance === undefined ||
          (estimate > 0 ? balance >= estimate : balance > 0);
        return [
          200,
          allowed
            ? { allowed: true }
            : { allowed: false, reason: "insufficient_balance" },
        ];
      }
      case "/api/internal/v1/billing/usage-events":
        return ingest(body);
      case "/api/internal/v1/training/eval-versions": {
        const artifactId = String(body.artifact_id ?? "");
        const [name, version] = artifactId.split("@");
        if (!name || !version) return [422, { detail: "not name@version" }];
        const model = `${FAKE_ORG_SLUG}/${name}/${version}`;
        evalVersions.push({ workspace_id: ws, artifact_id: artifactId, model });
        return [200, { model, eval_only: true }];
      }
      case "/api/internal/v1/training/traces:pull": {
        // The cursor is opaque to grad: here, the ingestion offset already read.
        const rows = gatewayRecords.get(ws) ?? [];
        const filter = (body.filter ?? {}) as { models?: string[] };
        const offset =
          body.cursor === null || body.cursor === undefined
            ? 0
            : Number(body.cursor);
        const limit = Math.max(1, Math.min(500, Number(body.limit ?? 500)));
        const page = rows.slice(offset, offset + limit).filter((r) => {
          const model = (r.metadata as { model?: string } | undefined)?.model;
          return (
            r.type !== "trace" ||
            !filter.models ||
            filter.models.includes(String(model))
          );
        });
        const next = Math.min(rows.length, offset + limit);
        return [
          200,
          { records: page, cursor: String(next), has_more: next < rows.length },
        ];
      }
      default:
        return [404, { detail: `unknown internal route ${path}` }];
    }
  };

  const control = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<[number, unknown]> => {
    const ws = String(body.workspace_id ?? "");
    switch (path) {
      case "/_control/gateway-records": {
        const list = gatewayRecords.get(ws) ?? [];
        list.push(...((body.records ?? []) as Record<string, unknown>[]));
        gatewayRecords.set(ws, list);
        return [200, { records: list.length }];
      }
      case "/_control/keys":
        if (!auth) return [501, { detail: "no auth database" }];
        if (body.remove === true) await auth.remove(String(body.token));
        else await auth.add(String(body.token), body as unknown as FakeKey);
        return [200, {}];
      case "/_control/console-token":
        return [
          200,
          {
            token: consoleToken(
              ws,
              body.role === "member" ? "member" : "admin",
            ),
          },
        ];
      case "/_control/service-token":
        return [
          200,
          { token: serviceJwt(ws, (body.scopes ?? []) as string[]) },
        ];
      case "/_control/balance":
        if (body.nano_usd === null) balances.delete(ws);
        else balances.set(ws, Number(body.nano_usd));
        return [200, {}];
      case "/_control/usage-events":
        return [200, { events: usageEvents }];
      default:
        return [404, { detail: `unknown control route ${path}` }];
    }
  };

  const gateway = async (
    req: IncomingMessage,
    body: Record<string, unknown>,
  ): Promise<[number, unknown]> => {
    if (req.headers.authorization !== `Bearer ${gatewayToken}`) {
      return [401, { error: { message: "invalid gateway credential" } }];
    }
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === "string" ? value : null;
    };
    gatewayCalls.push({
      model: String(body.model ?? ""),
      workspace: header("x-gradiated-workspace"),
      source: header("x-gradiated-source"),
      eval_id: header("x-gradiated-eval-id"),
    });
    if (!header("x-gradiated-workspace")) {
      return [400, { error: { message: "X-Gradiated-Workspace is required" } }];
    }
    if (!options.gatewayUpstream) {
      return [
        200,
        {
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ];
    }
    const upstream = await fetch(
      `${options.gatewayUpstream}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grad-Workspace": header("x-gradiated-workspace") ?? "",
        },
        body: JSON.stringify(body),
      },
    );

    return [upstream.status, (await upstream.json()) as unknown];
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = "/"] = (req.url ?? "/").split("?");
      const method = req.method ?? "GET";
      const body: Record<string, unknown> = await readJson(req).catch(
        () => ({}),
      );
      requests.push({ method, path, body });

      const send = (status: number, payload: unknown, headers = {}) => {
        const write = () => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            ...headers,
          });
          res.end(status === 304 ? undefined : JSON.stringify(payload));
        };
        if (latencyMs > 0 && path.startsWith("/api/"))
          setTimeout(write, latencyMs);
        else write();
      };

      const failure = failures.find(
        (f) => f.remaining > 0 && (!f.path || f.path === path),
      );

      try {
        // The JWKS is public; failNext with its path takes it down.
        if (path === "/api/auth/jwks") {
          if (failure?.path === path) {
            failure.remaining -= 1;
            return send(failure.status, { detail: "injected failure" });
          }
          return send(200, { keys: signingKeys.map((k) => k.jwk) });
        }
        if (path.startsWith("/_control/")) {
          const [status, payload] = await control(path, body);
          return send(status, payload);
        }
        if (path === "/gateway/v1/chat/completions") {
          const [status, payload] = await gateway(req, body);
          return send(status, payload);
        }
        if (req.headers.authorization !== `Bearer ${serviceToken}`) {
          return send(401, { detail: "invalid service token" });
        }
        if (failure) {
          failure.remaining -= 1;
          return send(failure.status, { detail: "injected failure" });
        }
        const once = canned.get(path)?.shift();
        if (once) return send(once.status, once.body);

        if (path === "/api/internal/v1/billing/prices" && method === "GET") {
          const etag = `"${currentPrices}"`;
          if (req.headers["if-none-match"] === etag)
            return send(304, null, { ETag: etag });
          return send(
            200,
            {
              price_version: currentPrices,
              product: "training",
              placeholder: false,
              effective_at: new Date(0).toISOString(),
              skus: Object.entries(priceVersions.get(currentPrices) ?? {}).map(
                ([sku, price]) => ({
                  sku,
                  unit: "token",
                  price_nano_usd_per_mtok: price,
                }),
              ),
            },
            { ETag: etag },
          );
        }
        if (method !== "POST") return send(405, { detail: "POST only" });
        const [status, payload] = internal(path, body);
        return send(status, payload);
      } catch (error) {
        return send(500, {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}`;

  return {
    url,
    serviceToken,
    jwksUrl: `${url}/api/auth/jwks`,
    issuer: url,
    billingUrl: `${url}/api/internal/v1/billing`,
    pricesUrl: `${url}/api/internal/v1/billing/prices?product=training`,
    gatewayUrl: `${url}/gateway/v1`,
    gatewayToken,
    authDatabaseUrl: auth?.url ?? null,
    addKey: async (token, key) => {
      if (!auth)
        throw new Error("startFakeCloudApi needs databaseUrl for keys");
      await auth.add(token, key);
    },
    removeKey: async (token) => {
      await auth?.remove(token);
    },
    signJwt,
    consoleToken,
    serviceJwt,
    rotateSigningKey,
    balances,
    suspended,
    usageEvents,
    setPrices: (version, skus) => {
      priceVersions.set(version, { ...skus });
      currentPrices = version;
    },
    gatewayCalls,
    evalVersions,
    gatewayRecords,
    requests,
    failNext: (count, status = 503, path) =>
      failures.push({ remaining: count, status, ...(path ? { path } : {}) }),
    setLatency: (ms) => {
      latencyMs = ms;
    },
    respondOnce: (path, status, body) => {
      const list = canned.get(path) ?? [];
      list.push({ status, body });
      canned.set(path, list);
    },
    callsTo: (path) => requests.filter((r) => r.path === path),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await auth?.drop();
    },
  };
};
