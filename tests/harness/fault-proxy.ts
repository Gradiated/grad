/**
 * Live-test fault injection: a reverse proxy in front of one or more
 * grad-server replicas.
 *
 * - Keyed POSTs (SDK Idempotency-Key): the first attempt is forwarded, the
 *   server commits it, and the client gets 503 instead of the real response.
 *   The SDK's retry (same key) gets the stored response replayed with
 *   `Idempotent-Replayed: true`.
 * - Worker POSTs (`/v1/trainer-jobs/*`, natural keys, no Idempotency-Key):
 *   with `dropWorkerAckEvery: n`, every n-th one is forwarded and committed,
 *   then the client connection is closed without a response (the lost ack).
 * - Several targets: requests round-robin over the replicas and fail over to
 *   the next when one refuses the connection (a killed replica).
 *
 * Everything else passes through unchanged. `GET /__fault/stats` reports
 * what happened.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface FaultStats {
  dropped: number;
  replayed: number;
  /** Worker POSTs whose response was cut after the server committed them. */
  droppedWorkerAcks: number;
  /** Requests re-sent to another replica after a connection failure. */
  failovers: number;
}

export interface FaultProxyOptions {
  /** Cut the response of every n-th trainer-job POST (0: never). */
  dropWorkerAckEvery?: number;
}

export interface FaultProxy {
  url: string;
  stats: FaultStats;
  close(): Promise<void>;
}

const HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
]);

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const forwardHeaders = (req: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(name) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
};

export const startFaultProxy = async (
  target: string | readonly string[],
  options: FaultProxyOptions = {},
): Promise<FaultProxy> => {
  const targets = typeof target === "string" ? [target] : [...target];
  const stats: FaultStats = {
    dropped: 0,
    replayed: 0,
    droppedWorkerAcks: 0,
    failovers: 0,
  };
  const seenKeys = new Set<string>();
  let nextTarget = 0;
  let workerPosts = 0;

  /** Round-robin; a replica that refuses the connection is skipped. */
  const forward = async (path: string, init: RequestInit) => {
    const first = nextTarget++ % targets.length;
    let lastError: unknown;
    for (let i = 0; i < targets.length; i += 1) {
      const base = targets[(first + i) % targets.length] as string;
      try {
        return await fetch(`${base}${path}`, init);
      } catch (error) {
        lastError = error;
        stats.failovers += 1;
      }
    }
    throw lastError;
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === "/__fault/stats") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(stats));
        return;
      }

      const body = await readBody(req);
      const method = req.method ?? "GET";
      const upstream = await forward(req.url ?? "/", {
        method,
        headers: forwardHeaders(req),
        redirect: "manual",
        ...(method === "GET" || method === "HEAD" ? {} : { body }),
      });

      const every = options.dropWorkerAckEvery ?? 0;
      if (
        every > 0 &&
        method === "POST" &&
        req.url?.startsWith("/v1/trainer-jobs/") &&
        (workerPosts += 1) % every === 0
      ) {
        await upstream.arrayBuffer();
        stats.droppedWorkerAcks += 1;
        req.socket.destroy();
        return;
      }

      const key = req.headers["idempotency-key"];
      if (method === "POST" && typeof key === "string" && !seenKeys.has(key)) {
        seenKeys.add(key);
        await upstream.arrayBuffer();
        stats.dropped += 1;
        res.writeHead(503, { "content-type": "application/problem+json" });
        res.end(
          JSON.stringify({
            type: "https://gradiated.com/problems/injected_fault",
            title: "Injected fault",
            status: 503,
            code: "injected_fault",
            detail:
              "The test fault proxy dropped this response after grad-server committed the request.",
            request_id: "req_fault_proxy",
          }),
        );
        return;
      }

      if (upstream.headers.get("idempotent-replayed") === "true") {
        stats.replayed += 1;
      }
      const headers: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!HOP_HEADERS.has(name) && name !== "content-encoding") {
          headers[name] = value;
        }
      });
      res.writeHead(upstream.status, headers);
      if (upstream.body) {
        for await (const chunk of upstream.body) res.write(chunk);
      }
      res.end();
    })().catch((error: unknown) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`fault proxy: ${String(error)}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
