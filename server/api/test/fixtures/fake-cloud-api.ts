import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test double for the Gradiated Cloud internal API used by the Cloud adapters
 * (src/adapters-cloud.ts). It is a real HTTP server so the adapters' network
 * code runs unmodified. Decisions and embeddings are deterministic fixtures.
 */

export interface FakePrincipal {
  workspace_id: string;
  scopes: string[];
  actor?: string;
  is_platform_admin?: boolean;
}

export interface UsageEntry {
  idempotency_key: string;
  workspace_id: string;
  run_id: string;
  attempt: number;
  tokens_processed: number;
  cost_usd: number;
}

export interface LoggedRequest {
  path: string;
  idempotency_key: string | null;
  body: Record<string, unknown>;
}

export interface FakeCloudApi {
  url: string;
  serviceToken: string;
  /** Bearer tokens accepted by /auth/verify. */
  tokens: Map<string, FakePrincipal>;
  /** workspace → remaining balance (USD); missing = unlimited. */
  balances: Map<string, number>;
  /** Accepted usage entries, deduplicated by Idempotency-Key. */
  usage: UsageEntry[];
  /** Every request received, in order. */
  requests: LoggedRequest[];
  artifacts: Map<string, Record<string, unknown>>;
  deployments: Map<string, { artifact_id: string; model_id: string }>;
  /** The next `count` requests to `path` (or any path) return HTTP `status`. */
  failNext(count: number, status?: number, path?: string): void;
  /** Delay every response by `ms`. */
  setLatency(ms: number): void;
  /** Override the JSON body returned for the next request to `path`. */
  respondOnce(path: string, status: number, body: unknown): void;
  callsTo(path: string): LoggedRequest[];
  close(): Promise<void>;
}

export const EMBEDDING_DIMENSIONS = 8;

const readJson = async (
  req: IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");

  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
};

const embed = (text: string): number[] => {
  const vec = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
    [...text].reduce(
      (acc, ch, j) => acc + ((ch.charCodeAt(0) * (i + 1) + j) % 7),
      1,
    ),
  );
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));

  return vec.map((v) => Number((v / norm).toFixed(6)));
};

export const startFakeCloudApi = async (
  options: { serviceToken?: string } = {},
): Promise<FakeCloudApi> => {
  const serviceToken = options.serviceToken ?? "svc_test_token";
  const tokens = new Map<string, FakePrincipal>();
  const balances = new Map<string, number>();
  const usage: UsageEntry[] = [];
  const requests: LoggedRequest[] = [];
  const artifacts = new Map<string, Record<string, unknown>>();
  const deployments = new Map<
    string,
    { artifact_id: string; model_id: string }
  >();
  const failures: Array<{ remaining: number; status: number; path?: string }> =
    [];
  const canned = new Map<string, Array<{ status: number; body: unknown }>>();
  let latencyMs = 0;

  const handle = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<[number, unknown]> => {
    const ws = String(body.workspace_id ?? "");

    switch (path) {
      case "/api/internal/v1/auth/verify": {
        const principal = tokens.get(String(body.token ?? ""));
        return principal
          ? [200, { valid: true, ...principal }]
          : [200, { valid: false }];
      }
      case "/api/internal/v1/billing/check": {
        const balance = balances.get(ws);
        const estimate = Number(body.estimated_cost_usd ?? 0);
        return balance === undefined || balance >= estimate
          ? [200, { allowed: true }]
          : [
              200,
              {
                allowed: false,
                reason: `Balance $${balance} is below $${estimate}.`,
              },
            ];
      }
      case "/api/internal/v1/artifacts/publish": {
        artifacts.set(`${ws}:${String(body.artifact_id)}`, body);
        return [200, { published: true }];
      }
      case "/api/internal/v1/deployments/promote": {
        const artifactKey = `${ws}:${String(body.artifact_id)}`;
        if (!artifacts.has(artifactKey)) {
          return [404, { detail: "artifact not published" }];
        }
        const modelId = `${ws}/${String(body.deployment_name)}`;
        deployments.set(`${ws}:${String(body.deployment_name)}`, {
          artifact_id: String(body.artifact_id),
          model_id: modelId,
        });
        return [200, { model_id: modelId }];
      }
      case "/api/internal/v1/serving/route": {
        const dep = deployments.get(`${ws}:${String(body.deployment)}`);
        if (!dep) return [404, { detail: "deployment not serving" }];
        const manifest = (artifacts.get(`${ws}:${dep.artifact_id}`)?.manifest ??
          {}) as { router_config?: { candidates?: string[] } };
        const candidates = manifest.router_config?.candidates ?? [];
        const fallback =
          typeof body.fallback_model === "string" ? body.fallback_model : null;
        const messages = (body.messages ?? []) as Array<{ content?: unknown }>;
        const length = messages
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .join("").length;
        const cheap = candidates[0] ?? fallback ?? dep.model_id;
        const strong = fallback ?? candidates[candidates.length - 1] ?? cheap;
        const model = length > 200 ? strong : cheap;
        return [
          200,
          {
            model,
            is_exploration: false,
            confidence: 0.9,
            scores: { [cheap]: length > 200 ? 0.3 : 0.9, [strong]: 0.95 },
          },
        ];
      }
      case "/api/internal/v1/serving/embeddings": {
        if (!deployments.has(`${ws}:${String(body.deployment)}`)) {
          return [404, { detail: "deployment not serving" }];
        }
        const inputs = (body.input ?? []) as string[];
        const tokensUsed = inputs.reduce(
          (s, t) => s + Math.ceil(t.length / 4),
          0,
        );
        return [
          200,
          {
            data: inputs.map((text, index) => ({
              index,
              embedding: embed(text),
            })),
            usage: { prompt_tokens: tokensUsed, total_tokens: tokensUsed },
          },
        ];
      }
      default:
        return [404, { detail: `unknown internal route ${path}` }];
    }
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const body: Record<string, unknown> = await readJson(req).catch(
        () => ({}),
      );
      const idempotencyKey =
        (req.headers["idempotency-key"] as string | undefined) ?? null;
      requests.push({ path, idempotency_key: idempotencyKey, body });

      const send = (status: number, payload: unknown) => {
        const write = () => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (latencyMs > 0) setTimeout(write, latencyMs);
        else write();
      };

      if (req.method !== "POST") return send(405, { detail: "POST only" });
      if (req.headers.authorization !== `Bearer ${serviceToken}`) {
        return send(401, { detail: "invalid service token" });
      }

      const failure = failures.find(
        (f) => f.remaining > 0 && (!f.path || f.path === path),
      );
      if (failure) {
        failure.remaining -= 1;
        return send(failure.status, { detail: "injected failure" });
      }

      const once = canned.get(path)?.shift();
      if (once) return send(once.status, once.body);

      if (path === "/api/internal/v1/billing/usage") {
        if (!idempotencyKey)
          return send(400, { detail: "Idempotency-Key required" });
        if (!usage.some((u) => u.idempotency_key === idempotencyKey)) {
          usage.push({
            idempotency_key: idempotencyKey,
            workspace_id: String(body.workspace_id),
            run_id: String(body.run_id),
            attempt: Number(body.attempt),
            tokens_processed: Number(body.tokens_processed),
            cost_usd: Number(body.cost_usd),
          });
        }
        return send(200, { recorded: true });
      }

      const [status, payload] = await handle(path, body);
      return send(status, payload);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    serviceToken,
    tokens,
    balances,
    usage,
    requests,
    artifacts,
    deployments,
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
