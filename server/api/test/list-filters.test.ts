import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp, type TestApp } from "./fixtures/app.js";
import {
  makeEvalHarness,
  qaRecords,
  seedArtifact,
  seedDataset,
} from "./fixtures/evals.js";
import { createSftRun } from "./fixtures/worker.js";

type Named = { data: { id: string; name?: string; dataset?: string }[] };

// The web console filters on the server, so a status tab or a search is right
// past the first page (it used to filter the newest 100 rows in the browser).
describe("list filters: status, q and an import's dataset", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const names = async (path: string) =>
    (await t.json<Named>(path)).body.data.map((r) => r.name ?? r.dataset);

  it("narrows runs by status and by a name substring or exact id", async () => {
    const a = await createSftRun(t, { name: "support-sft" });
    t.clock.advance(1000);
    await createSftRun(t, { name: "billing_100" });
    await t.json(`/v1/runs/${a.id}/cancel`, { method: "POST" });

    expect(await names("/v1/runs?status=queued")).toEqual(["billing_100"]);
    expect(await names("/v1/runs?status=queued,cancelled")).toEqual([
      "billing_100",
      "support-sft",
    ]);
    expect(await names("/v1/runs?status=failed")).toEqual([]);
    expect(await names("/v1/runs?q=SUPPORT")).toEqual(["support-sft"]);
    // LIKE wildcards are literal: "_" matches only an underscore.
    expect(await names("/v1/runs?q=g_1")).toEqual(["billing_100"]);
    expect(await names("/v1/runs?q=t_s")).toEqual([]);
    expect(await names("/v1/runs?q=%25")).toEqual([]);
    expect(await names(`/v1/runs?q=${a.id}`)).toEqual(["support-sft"]);

    const bad = await t.json("/v1/runs?status=running,nope");
    expect(bad.status).toBe(422);
  });

  it("pages a filtered list with the same cursor", async () => {
    for (let i = 0; i < 3; i++) {
      await createSftRun(t, { name: `keep-${i}` });
      t.clock.advance(1000);
    }
    await createSftRun(t, { name: "other" });
    const first = await t.json<Named & { next_cursor: string | null }>(
      "/v1/runs?q=keep&limit=2",
    );
    expect(first.body.data.map((r) => r.name)).toEqual(["keep-2", "keep-1"]);
    const rest = await names(
      `/v1/runs?q=keep&limit=2&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`,
    );
    expect(rest).toEqual(["keep-0"]);
  });

  it("narrows datasets by name, and imports by dataset and status", async () => {
    await createSftRun(t, { dataset: "support" });
    await createSftRun(t, { dataset: "billing" });
    expect(await names("/v1/datasets?q=bill")).toEqual(["billing"]);

    const hf = {
      kind: "hf",
      repo: "trl-lib/ultrafeedback_binarized",
      split: "train",
    };
    for (const ds of ["support", "billing", "support"]) {
      t.clock.advance(1000);
      const res = await t.json(`/v1/datasets/${ds}/imports`, {
        body: { source: hf },
      });
      expect(res.status).toBe(202);
    }
    expect(await names("/v1/imports?dataset=support")).toEqual([
      "support",
      "support",
    ]);
    expect(await names("/v1/imports?dataset=billing&status=queued")).toEqual([
      "billing",
    ]);
    expect(await names("/v1/imports?status=completed")).toEqual([]);
  });
});

describe("list filters: an eval's status and an artifact's name", () => {
  it("narrows evals by status and artifacts by a name substring", async () => {
    const h = await makeEvalHarness();
    try {
      await seedDataset(h.t, "qa", qaRecords(2));
      const created = await h.t.json<{ id: string }>("/v1/evals", {
        body: { models: ["qwen/qwen3-8b"], dataset: "qa", name: "nightly" },
      });
      expect(created.status).toBe(202);
      const ids = async (path: string) =>
        (await h.t.json<{ data: { id: string }[] }>(path)).body.data.map(
          (r) => r.id,
        );
      expect(await ids("/v1/evals?status=queued")).toEqual([created.body.id]);
      expect(await ids("/v1/evals?status=completed,failed")).toEqual([]);

      await seedArtifact(h.t, "support-sft");
      h.t.clock.advance(1000);
      await seedArtifact(h.t, "billing-router");
      const names = async (path: string) =>
        (await h.t.json<{ data: { name: string }[] }>(path)).body.data.map(
          (r) => r.name,
        );
      expect(await names("/v1/artifacts?q=ROUTER")).toEqual(["billing-router"]);
      expect(await names("/v1/artifacts?q=sft&name=support-sft")).toEqual([
        "support-sft",
      ]);
      expect(await names("/v1/artifacts?q=nothing")).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
