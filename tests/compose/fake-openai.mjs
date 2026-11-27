// OpenAI-compatible inference fixture for the compose smoke test: replies
// "answer: <last user message>" to POST /v1/chat/completions. Test-only.
import { createServer } from "node:http";

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const user = [...body.messages].reverse().find((m) => m.role === "user");
  const content = `answer: ${typeof user?.content === "string" ? user.content : ""}`;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-smoke",
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
});

server.listen(8080, "0.0.0.0");
process.once("SIGTERM", () => server.close(() => process.exit(0)));
