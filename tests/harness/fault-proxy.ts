/**
 * Live-test fault injection for Idempotency-Key retries: a reverse proxy in
 * front of grad-server that forwards the first attempt of every keyed POST,
 * lets the server commit it, then answers the client 503 instead of the real
 * response. The SDK's retry (same key) reaches the server, which replays the
 * stored response with `Idempotent-Replayed: true`. Everything else passes
 * through unchanged. `GET /__fault/stats` reports what happened.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface FaultStats {
  dropped: number;
  replayed: number;
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

export const startFaultProxy = async (target: string): Promise<FaultProxy> => {
  const stats: FaultStats = { dropped: 0, replayed: 0 };
  const seenKeys = new Set<string>();

  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === "/__fault/stats") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(stats));
        return;
      }

      const body = await readBody(req);
      const method = req.method ?? "GET";
      const upstream = await fetch(`${target}${req.url ?? "/"}`, {
        method,
        headers: forwardHeaders(req),
        redirect: "manual",
        ...(method === "GET" || method === "HEAD" ? {} : { body }),
      });

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
