import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  createLocalNoneAuth,
  createNoopBillingAdapter,
} from "../src/adapters.js";
import { buildOpenApiDocument, createApp } from "../src/app.js";
import { createModelCatalog } from "../src/catalog.js";
import { systemClock } from "../src/clock.js";
import { S3ObjectStore } from "../src/storage/s3.js";
import type { Store } from "../src/store/types.js";

/**
 * DatasetRecord as a standalone JSON Schema (2020-12): the component and
 * every component it references, under `$defs`.
 */
const recordSchema = (document: {
  components?: { schemas?: Record<string, unknown> };
}): Record<string, unknown> => {
  const all = document.components?.schemas ?? {};
  const defs: Record<string, unknown> = {};
  const visit = (name: string) => {
    if (name in defs) return;
    defs[name] = all[name];
    const refs = JSON.stringify(all[name]).matchAll(
      /"#\/components\/schemas\/([^"]+)"/g,
    );
    for (const [, ref] of refs) visit(ref as string);
  };
  visit("DatasetRecord");
  const body = JSON.stringify(defs).replaceAll(
    "#/components/schemas/",
    "#/$defs/",
  );

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $comment:
      "Generated from spec/openapi.yaml by server/api/scripts/emit-openapi.ts; do not edit.",
    $ref: "#/$defs/DatasetRecord",
    $defs: JSON.parse(body) as Record<string, unknown>,
  };
};

const run = async () => {
  const check = process.argv.includes("--check");
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.resolve(scriptDir, "../../../spec/openapi.yaml");

  const app = createApp({
    store: {} as Store,
    // Never called: emitting the document makes no storage requests.
    storage: new S3ObjectStore({ bucket: "grad-openapi-unused" }),
    auth: createLocalNoneAuth(),
    billing: createNoopBillingAdapter(),
    catalog: createModelCatalog(),
    clock: systemClock,
    inferenceConfigured: false,
    settings: { maxAttempts: 3 },
  });

  const document = buildOpenApiDocument(app);
  const rendered = YAML.stringify(document, { lineWidth: 120 });
  // The trainer validates the records it writes against the same schema.
  const recordPath = path.resolve(
    scriptDir,
    "../../trainer/grad_trainer/record.schema.json",
  );
  const record = `${JSON.stringify(recordSchema(document), null, 2)}\n`;

  if (check) {
    for (const [file, want] of [
      [outPath, rendered],
      [recordPath, record],
    ] as const) {
      const existing = await readFile(file, "utf8").catch(() => "");
      if (existing !== want) {
        console.error(
          `Drift detected in ${file}. Run 'pnpm -C server/api openapi:generate'.`,
        );
        process.exit(1);
      }
    }

    console.log("spec/openapi.yaml is up to date.");
    return;
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, rendered, "utf8");
  await writeFile(recordPath, record, "utf8");
  console.log(`Wrote ${outPath} and ${recordPath}`);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
