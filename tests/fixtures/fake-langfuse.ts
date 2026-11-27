import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A Langfuse-like observability server for live source-sync tests. It serves
 * the parts of the Langfuse public API the `langfuse` source reads, with
 * Langfuse's opaque `meta.cursor` pagination and Basic auth (`pk:sk`):
 *
 *   GET /api/public/v2/observations?isRootObservation=true&fromStartTime&cursor&limit
 *       (one root observation per trace, newest first; io fields are JSON strings)
 *   GET /api/public/v3/scores?fromTimestamp&cursor&limit   (subject = the trace)
 *
 * Tests drive it over HTTP (no auth, loopback only), so any language can:
 *
 *   POST /_control/traces   [trace, ...]         add or replace traces by id
 *   POST /_control/scores   [score, ...]         add or replace scores by id
 *   POST /_control/fail     {path, status, count} the next `count` provider
 *                                                requests whose path starts
 *                                                with `path` answer `status`
 *   GET  /_control/requests                      every provider request
 *   POST /_control/reset
 *
 * Every list is finite: pages past the last one are empty.
 */

export interface FakeTrace {
  id: string;
  timestamp: string;
  name?: string | null;
  input?: unknown;
  output?: unknown;
  sessionId?: string | null;
  userId?: string | null;
  release?: string | null;
  version?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  environment?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface FakeScore {
  id: string;
  traceId: string;
  name: string;
  dataType?: "NUMERIC" | "BOOLEAN" | "CATEGORICAL" | "CORRECTION";
  value?: number | string | null;
  comment?: string | null;
  source?: "API" | "ANNOTATION" | "EVAL";
  timestamp: string;
  createdAt?: string;
  updatedAt?: string;
  observationId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface FakeProviderRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorized: boolean;
}

export interface FakeLangfuse {
  url: string;
  publicKey: string;
  secretKey: string;
  /** The value to store as the grad secret: `public_key:secret_key`. */
  secret: string;
  traces: Map<string, FakeTrace>;
  scores: Map<string, FakeScore>;
  requests: FakeProviderRequest[];
  failNext(path: string, status: number, count: number): void;
  close(): Promise<void>;
}

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");

  return text ? JSON.parse(text) : null;
};

const byTime = <T extends { timestamp: string; id: string }>(
  order: string | null,
) => {
  const desc = order?.endsWith(".desc") ?? false;

  return (a: T, b: T): number => {
    const d = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    const cmp = d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

    return desc ? -cmp : cmp;
  };
};

const withDefaults = (trace: FakeTrace) => ({
  name: null,
  input: null,
  output: null,
  sessionId: null,
  userId: null,
  release: null,
  version: null,
  tags: [],
  metadata: null,
  environment: "default",
  createdAt: trace.timestamp,
  updatedAt: trace.timestamp,
  ...trace,
});

export const startFakeLangfuse = async (
  options: { publicKey?: string; secretKey?: string; port?: number } = {},
): Promise<FakeLangfuse> => {
  const publicKey = options.publicKey ?? "pk-lf-fake";
  const secretKey = options.secretKey ?? "sk-lf-fake-secret";
  const expectedAuth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  const traces = new Map<string, FakeTrace>();
  const scores = new Map<string, FakeScore>();
  const requests: FakeProviderRequest[] = [];
  const failures: Array<{ path: string; status: number; remaining: number }> =
    [];

  const failNext = (path: string, status: number, count: number) => {
    failures.push({ path, status, remaining: count });
  };

  /** Opaque offset cursors, as Langfuse's own are opaque; omitted on the last page. */
  const cursorPage = <T>(items: T[], query: URLSearchParams, max: number) => {
    const limit = Math.min(
      max,
      Math.max(1, Number(query.get("limit") ?? 50) || 50),
    );
    const offset = Number(
      Buffer.from(query.get("cursor") ?? "", "base64url").toString() || 0,
    );
    const data = items.slice(offset, offset + limit);
    const next =
      offset + limit < items.length
        ? Buffer.from(String(offset + limit)).toString("base64url")
        : null;

    return { data, meta: { limit, ...(next ? { cursor: next } : {}) } };
  };

  const observation = (trace: FakeTrace) => {
    const t = withDefaults(trace);

    return {
      id: `obs_${t.id}`,
      traceId: t.id,
      startTime: t.timestamp,
      endTime: t.timestamp,
      projectId: "proj_fake",
      parentObservationId: null,
      type: "GENERATION",
      name: t.name ?? "generation",
      level: "DEFAULT",
      version: t.version,
      environment: t.environment,
      userId: t.userId,
      sessionId: t.sessionId,
      isRootObservation: true,
      input: t.input === null ? null : JSON.stringify(t.input),
      output: t.output === null ? null : JSON.stringify(t.output),
      metadata: t.metadata,
      model: (t.metadata?.model as string | undefined) ?? null,
      tags: t.tags,
      release: t.release,
      traceName: t.name,
    };
  };

  const provider = (
    path: string,
    query: URLSearchParams,
  ): [number, unknown] => {
    if (path === "/api/public/v2/observations") {
      if (query.get("isRootObservation") !== "true") {
        return [400, { message: "this fake serves root observations only" }];
      }
      const from = query.get("fromStartTime");
      const items = [...traces.values()]
        .filter((t) => !from || Date.parse(t.timestamp) >= Date.parse(from))
        .sort(byTime("timestamp.desc"))
        .map(observation);

      return [200, cursorPage(items, query, 1000)];
    }

    if (path === "/api/public/v3/scores") {
      const from = query.get("fromTimestamp");
      const items = [...scores.values()]
        .filter((s) => !from || Date.parse(s.timestamp) >= Date.parse(from))
        .sort(byTime("timestamp.asc"))
        .map((s) => ({
          id: s.id,
          projectId: "proj_fake",
          name: s.name,
          dataType: s.dataType ?? "NUMERIC",
          value: s.value ?? null,
          source: s.source ?? "API",
          comment: s.comment ?? null,
          metadata: s.metadata ?? null,
          configId: null,
          environment: "default",
          timestamp: s.timestamp,
          createdAt: s.createdAt ?? s.timestamp,
          updatedAt: s.updatedAt ?? s.timestamp,
          subject: { kind: "trace", id: s.traceId },
        }));

      return [200, cursorPage(items, query, 100)];
    }

    return [404, { message: `No route ${path}` }];
  };

  const control = async (
    method: string,
    path: string,
    req: IncomingMessage,
  ): Promise<[number, unknown]> => {
    if (method === "GET" && path === "/_control/requests") {
      return [200, requests];
    }

    const body = method === "POST" ? await readJson(req) : null;
    switch (path) {
      case "/_control/traces":
        for (const t of (body ?? []) as FakeTrace[]) traces.set(t.id, t);
        return [200, { traces: traces.size }];
      case "/_control/scores":
        for (const s of (body ?? []) as FakeScore[]) scores.set(s.id, s);
        return [200, { scores: scores.size }];
      case "/_control/fail": {
        const f = (body ?? {}) as {
          path?: string;
          status?: number;
          count?: number;
        };
        failNext(f.path ?? "/", f.status ?? 500, f.count ?? 1);
        return [200, { ok: true }];
      }
      case "/_control/reset":
        traces.clear();
        scores.clear();
        requests.length = 0;
        failures.length = 0;
        return [200, { ok: true }];
      default:
        return [404, { message: `No control route ${path}` }];
    }
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-langfuse");
    const send = ([status, body]: [number, unknown]) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.startsWith("/_control/")) {
      control(req.method ?? "GET", url.pathname, req).then(send, (error) =>
        send([400, { message: String(error) }]),
      );
      return;
    }

    const authorized = req.headers.authorization === expectedAuth;
    requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorized,
    });
    if (!authorized) {
      send([401, { message: "Invalid credentials" }]);
      return;
    }

    const failure = failures.find(
      (f) => f.remaining > 0 && url.pathname.startsWith(f.path),
    );
    if (failure) {
      failure.remaining -= 1;
      send([failure.status, { message: "injected failure" }]);
      return;
    }

    send(
      req.method === "GET"
        ? provider(url.pathname, url.searchParams)
        : [405, { message: "read-only" }],
    );
  });

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    publicKey,
    secretKey,
    secret: `${publicKey}:${secretKey}`,
    traces,
    scores,
    requests,
    failNext,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
