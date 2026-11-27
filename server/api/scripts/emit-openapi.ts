import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  createDisabledDeployAdapter,
  createDisabledServingAdapter,
  createLocalNoneAuth,
  createNoopBillingAdapter,
} from "../src/adapters.js";
import { buildOpenApiDocument, createApp } from "../src/app.js";
import { createModelCatalog } from "../src/catalog.js";
import { systemClock } from "../src/clock.js";
import { createRegexEvaluator } from "../src/services/evals/regex.js";
import { LocalObjectStore } from "../src/storage/local.js";
import { createBlobSigner } from "../src/storage/signer.js";
import type { Store } from "../src/store/types.js";

const run = async () => {
  const check = process.argv.includes("--check");
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.resolve(scriptDir, "../../../spec/openapi.yaml");
  const regex = createRegexEvaluator();

  const app = createApp({
    store: {} as Store,
    storage: new LocalObjectStore(
      path.join(os.tmpdir(), "grad-openapi-unused"),
    ),
    signer: createBlobSigner("openapi"),
    auth: createLocalNoneAuth(),
    billing: createNoopBillingAdapter(),
    deploy: createDisabledDeployAdapter(),
    serving: createDisabledServingAdapter(),
    catalog: createModelCatalog(),
    clock: systemClock,
    inference: null,
    regex,
    settings: { maxAttempts: 3, evalConcurrency: 1 },
  });

  const rendered = YAML.stringify(buildOpenApiDocument(app), {
    lineWidth: 120,
  });
  await regex.close();

  if (check) {
    const existing = await readFile(outPath, "utf8").catch(() => "");
    if (existing !== rendered) {
      console.error(
        `OpenAPI drift detected in ${outPath}. Run 'pnpm -C server/api openapi:generate'.`,
      );
      process.exit(1);
    }

    console.log("spec/openapi.yaml is up to date.");
    return;
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, rendered, "utf8");
  console.log(`Wrote ${outPath}`);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
