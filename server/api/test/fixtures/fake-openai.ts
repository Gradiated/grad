import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeChatRequest {
  model: string;
  messages: Array<{ role: string; content?: unknown }>;
  temperature?: number;
  max_tokens?: number;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeReply {
  content?: string;
  status?: number;
  delayMs?: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export type FakeResponder = (request: FakeChatRequest) => FakeReply;

export interface FakeOpenAI {
  baseUrl: string;
  requests: FakeChatRequest[];
  /** Per-model responder; falls back to `defaultResponder`. */
  setModel: (model: string, responder: FakeResponder) => void;
  /** Fail the next `count` requests with HTTP `status`. */
  failNext: (count: number, status?: number) => void;
  close: () => Promise<void>;
}

const lastUserText = (request: FakeChatRequest): string => {
  const user = [...request.messages].reverse().find((m) => m.role === "user");

  return typeof user?.content === "string" ? user.content : "";
};

/** Deterministic default: echoes the last user message. */
export const defaultResponder: FakeResponder = (request) => ({
  content: `answer: ${lastUserText(request)}`,
});

/** Judge responder replying `{"score": x}`. */
export const judgeResponder =
  (score: number | ((request: FakeChatRequest) => number)): FakeResponder =>
  (request) => ({
    content: JSON.stringify({
      score: typeof score === "number" ? score : score(request),
    }),
  });

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  return Buffer.concat(chunks).toString("utf8");
};

/** Real HTTP OpenAI-compatible fake (`POST /v1/chat/completions`) on 127.0.0.1. */
export const startFakeOpenAI = async (): Promise<FakeOpenAI> => {
  const requests: FakeChatRequest[] = [];
  const responders = new Map<string, FakeResponder>();
  let failures: { count: number; status: number } = { count: 0, status: 503 };

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }

      const body = JSON.parse(await readBody(req)) as Omit<
        FakeChatRequest,
        "headers"
      >;
      const request: FakeChatRequest = { ...body, headers: req.headers };
      requests.push(request);

      if (failures.count > 0) {
        failures.count -= 1;
        res.writeHead(failures.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "injected failure" } }));
        return;
      }

      const reply = (responders.get(request.model) ?? defaultResponder)(
        request,
      );
      if (reply.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      }
      if (reply.status && reply.status >= 400) {
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "scripted failure" } }));
        return;
      }

      const content = reply.content ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: "chat.completion",
          model: request.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: reply.usage ?? {
            prompt_tokens: 10,
            completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
            total_tokens: 10 + Math.max(1, Math.ceil(content.length / 4)),
          },
        }),
      );
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setModel: (model, responder) => responders.set(model, responder),
    failNext: (count, status = 503) => {
      failures = { count, status };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
