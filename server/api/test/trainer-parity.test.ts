import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import type { ChatMessage, DatasetRecord } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import {
  routerGroupKey,
  splitForRecipe,
  splitRecords,
} from "../src/planner.js";
import { promptMessages } from "../src/records.js";
import { renderMessages, type RenderOptions } from "../src/render.js";
import {
  extendIndex,
  finishIndex,
  newIndexBuilder,
  readVersionPage,
} from "../src/services/dataset-pages.js";
import { writeRecordsPart } from "../src/services/dataset-records.js";
import { mergeRecords } from "../src/services/record-merge.js";
import { testObjectStore } from "./fixtures/s3.js";

// Golden files shared with the trainer's tests (server/trainer/tests): both
// sides replay the same inputs and must produce the same output.
const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      new URL(`../../trainer/tests/fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  ) as T;

describe("trainer parity", () => {
  it("splits records like grad_trainer.splits", () => {
    const cases = fixture<
      Array<{
        kind?: "router";
        records: DatasetRecord[];
        options: Parameters<typeof splitRecords>[1];
      }>
    >("split_parity_records.json");
    const expected = fixture<Array<{ train: number[]; eval: number[] }>>(
      "split_parity_expected.json",
    );

    const actual = cases.map((c) => {
      const split = c.kind
        ? splitForRecipe(c.kind, c.records, c.options)
        : splitRecords(c.records, c.options);
      const index = (r: DatasetRecord) => c.records.indexOf(r);

      return { train: split.train.map(index), eval: split.eval.map(index) };
    });

    expect(actual).toEqual(expected);
  });

  describe("merges dataset parts like grad_trainer.records", () => {
    const s3 = testObjectStore();
    afterAll(() => s3.close());
    const cases = fixture<
      Array<{
        name: string;
        parts: DatasetRecord[][];
        merged: DatasetRecord[];
      }>
    >("merge_parity.json");

    it.each(cases)("$name", async ({ parts, merged }) => {
      expect(mergeRecords(parts.flat())).toEqual(merged);

      // The page index, built part by part like successive pushes: every
      // prefix pages exactly what mergeRecords makes of it.
      const stored = [];
      const builder = newIndexBuilder();
      for (const [k, records] of parts.entries()) {
        stored.push(
          await writeRecordsPart(
            s3.storage,
            (sha) => `parity/${sha}.jsonl.gz`,
            records,
          ),
        );
        await extendIndex(s3.storage, builder, stored.slice(k));
        const index = finishIndex(builder);
        const expected = mergeRecords(parts.slice(0, k + 1).flat());
        expect(index.total).toBe(expected.length);
        for (const limit of [1, 100]) {
          const pages: DatasetRecord[] = [];
          for (let from = 0; from < index.total; from += limit) {
            pages.push(
              ...(await readVersionPage(
                s3.storage,
                stored,
                index,
                from,
                limit,
              )),
            );
          }
          expect(pages).toEqual(expected);
        }
      }
    });
  });

  describe("renders and groups prompts like grad_trainer.templates and recipes/data.py", () => {
    const { render, prompts } = fixture<{
      render: Array<{
        name: string;
        messages: ChatMessage[];
        tools: Array<Record<string, unknown>> | null;
        options: Omit<RenderOptions, "templateRevision">;
        text?: string;
        trained_text?: string;
        error?: true;
      }>;
      prompts: Array<{
        name: string;
        record: DatasetRecord;
        prompt: ChatMessage[];
        key: string;
      }>;
    }>("render_parity.json");

    it.each(render)("$name", (c) => {
      const run = () =>
        renderMessages(
          "r",
          c.messages,
          { ...c.options, templateRevision: "qwen3@3" },
          c.tools ?? undefined,
        );
      if (c.error) {
        expect(run).toThrow(ApiError);
        return;
      }
      const { spans } = run();
      expect(spans.map((s) => s.text).join("")).toBe(c.text);
      const trained = spans.filter((s) => s.trained);
      expect(trained.map((s) => s.text).join("")).toBe(c.trained_text);
    });

    it.each(prompts)("prompt group: $name", (c) => {
      expect(promptMessages(c.record)).toEqual(c.prompt);
      expect(routerGroupKey(c.record)).toBe(c.key);
    });
  });
});
