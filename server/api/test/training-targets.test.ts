import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createModelCatalog } from "../src/catalog.js";
import {
  PlanRunRequestSchema,
  type ChatMessage,
  type DatasetRecord,
} from "../src/contracts.js";
import { planRun } from "../src/planner.js";
import { renderMessages } from "../src/render.js";
import {
  assessRecipeUsability,
  correctionPair,
  ownConversation,
  recordConversation,
} from "../src/records.js";

/**
 * Shared with the trainer (server/trainer/tests/test_training_targets.py,
 * which checks the real token masks): the conversation each record trains
 * on, and the DPO pair a synced correction makes.
 */
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/records/training-targets.json",
);

interface Case {
  name: string;
  record: DatasetRecord;
  conversation: ChatMessage[];
  sft_usable: boolean;
  correction_pair: { chosen: ChatMessage[]; rejected: ChatMessage[] } | null;
}

const { cases } = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  cases: Case[];
};
const records = cases.map((c) => c.record);

describe("training targets (shared with the trainer)", () => {
  it.each(cases)("$name trains on its documented conversation", (c) => {
    expect(recordConversation(c.record)).toEqual(c.conversation);
    const pair = correctionPair(c.record);
    expect(pair && { chosen: pair[1], rejected: pair[2] }).toEqual(
      c.correction_pair,
    );
  });

  it("previews the loss mask: the prompt is context, only the answer trains", () => {
    for (const c of cases.filter((x) => x.sft_usable)) {
      const rendered = renderMessages(
        c.record.id ?? "r",
        recordConversation(c.record),
        {
          templateRevision: "qwen3@3",
          train_on: "last",
          thinking: "auto",
          preserve_thinking: false,
        },
      );
      const trained = rendered.spans.filter((s) => s.trained);
      expect(trained.map((s) => s.text)).toEqual([
        `${c.conversation.at(-1)?.content as string}<|im_end|>\n`,
      ]);
      const context = rendered.spans
        .filter((s) => !s.trained)
        .map((s) => s.text)
        .join("");
      for (const m of c.conversation.slice(0, -1)) {
        expect(context).toContain(m.content as string);
      }
      const rejected = c.correction_pair?.rejected[0]?.content;
      if (rejected) {
        expect(JSON.stringify(rendered.spans)).not.toContain(rejected);
        expect(ownConversation(c.record).at(-1)?.content).toBe(rejected);
      }
    }
  });

  it("counts the same usable records as the trainer, and reports the rest", () => {
    const sft = assessRecipeUsability("sft", records);
    expect(sft.usable).toBe(cases.filter((c) => c.sft_usable).length);
    expect(sft.unusable).toBe(cases.length - sft.usable);
    expect(sft.examples).toEqual(["np", "ao", "po"]);

    const dpo = assessRecipeUsability("dpo", records);
    expect(dpo.usable).toBe(cases.filter((c) => c.correction_pair).length);
    expect(dpo.unusable).toBe(cases.length - dpo.usable);
  });

  it("warns in the plan with the count, the reasons and example ids", () => {
    const catalog = createModelCatalog();
    const plan = (kind: string) =>
      planRun(
        PlanRunRequestSchema.parse({
          dataset: "d",
          name: "r",
          recipe: { kind },
        }),
        many,
        { catalog, datasetVersion: 1 },
      );
    const many = Array.from({ length: 10 }, (_, i) =>
      records.map((r) => ({ ...r, id: `${r.id}-${i}`, session_id: `s${i}` })),
    ).flat();
    const sft = plan("sft");
    const warning = sft.warnings.find((w) => w.includes("cannot be used"));
    expect(warning).toMatch(
      /^30 of 180 records cannot be used by 'sft' and will be skipped \(record has no prompt .*; record has no assistant answer .*\); for example 'np-0', 'ao-0', 'po-0'\.$/,
    );
    expect(sft.usable_records).toBe(150);

    const dpo = plan("dpo");
    expect(dpo.usable_records).toBe(40);
    expect(dpo.warnings.join(" ")).toMatch(
      /140 of 180 records cannot be used by 'dpo'.*for example 'pc-0', 'pcm-0', 'pe-0'/,
    );
  });
});
