import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  createLocalDeployAdapter,
  createLocalNoneAuth,
  createNoopBillingAdapter,
} from "../src/adapters.js";
import { buildOpenApiDocument, createApp } from "../src/app.js";
import { EnvWorkerHub } from "../src/env-hub.js";
import { LocalObjectStore } from "../src/storage.js";
import { InMemoryTrainingStore } from "../src/store.js";

const run = async () => {
  const check = process.argv.includes("--check");
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.resolve(scriptDir, "../../../spec/openapi.yaml");

  const app = createApp({
    store: new InMemoryTrainingStore(),
    storage: new LocalObjectStore("/tmp/grad-openapi-unused"),
    auth: createLocalNoneAuth(),
    billing: createNoopBillingAdapter(),
    deploy: createLocalDeployAdapter(),
    envHub: new EnvWorkerHub(),
  });

  const document = buildOpenApiDocument(app);
  const rendered = YAML.stringify(document, { lineWidth: 120 });

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

void run();
