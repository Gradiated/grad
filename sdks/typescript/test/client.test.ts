import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { Grad, GradApiError, adapters, recipes, splits } from "../src/index.js";

describe("@gradiated/grad TypeScript SDK", () => {
  it("constructs recipes and adapters without Full LLM fine-tuning", () => {
    expect("full" in adapters).toBe(false);
    expect(recipes.sft({ model: "qwen/qwen3-8b" }).kind).toBe("sft");
    expect(recipes.router().max_quality_drop).toBe(0.02);
    expect(recipes.cartridge({ num_tokens: 128 }).num_tokens).toBe(128);
    expect(splits.bySession(0.15).strategy).toBe("by_session");
  });

  it("calls wire endpoints, verifies artifact SHA-256, and throws GradApiError", async () => {
    const payload = Buffer.from("ts-bundle-bytes", "utf8");
    const sha = createHash("sha256").update(payload).digest("hex");

    const mockFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "qwen/qwen3-8b" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/v1/runs/plan" && init?.method === "POST") {
        return new Response(JSON.stringify({ estimated_cost_usd: 0.25 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/v1/artifacts/demo%40latest/download") {
        return new Response(payload, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Artifact-Sha256": sha,
          },
        });
      }
      return new Response(
        JSON.stringify({
          status: 404,
          code: "dataset_not_found",
          title: "Dataset not found",
          detail: "missing",
          request_id: "req_1",
        }),
        { status: 404, headers: { "Content-Type": "application/problem+json" } },
      );
    };

    const client = new Grad({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "grad_ts",
      fetchImpl: mockFetch,
    });

    const models = await client.models.list();
    expect(models).toEqual([{ id: "qwen/qwen3-8b" }]);

    const plan = await client.runs.plan({
      dataset: "support",
      name: "support-sft",
      recipe: recipes.sft(),
    });
    expect(plan.estimated_cost_usd).toBe(0.25);

    const downloaded = await client.artifacts.download("demo@latest");
    expect(Buffer.from(downloaded).toString("utf8")).toBe("ts-bundle-bytes");

    await expect(client.datasets.get("nope")).rejects.toBeInstanceOf(
      GradApiError,
    );
  });
});
