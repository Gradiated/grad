import type { AppDependencies } from "../deps.js";
import { createBillingOutbox, type BillingOutbox } from "./billing-outbox.js";
import { createDatasetService, type DatasetService } from "./datasets.js";
import { createEvalService, type EvalService } from "./evals/service.js";
import { createImportService, type ImportService } from "./imports.js";
import { createMaintenance, type Maintenance } from "./maintenance.js";
import { createRunLifecycle, type RunLifecycle } from "./runs.js";
import { createServingService, type ServingService } from "./serving.js";
import { createUploadService, type UploadService } from "./uploads.js";

export interface Services {
  datasets: DatasetService;
  uploads: UploadService;
  imports: ImportService;
  runs: RunLifecycle;
  billing: BillingOutbox;
  serving: ServingService;
  evals: EvalService;
  maintenance: Maintenance;
}

export const createServices = (deps: AppDependencies): Services => {
  const datasets = createDatasetService(deps);
  const uploads = createUploadService(deps);
  const billing = createBillingOutbox(deps);
  const imports = createImportService(deps, { datasets, uploads });
  const evals = createEvalService(deps, datasets, billing);
  const runs = createRunLifecycle(deps, { datasets, uploads, billing, evals });
  const serving = createServingService(deps);
  const maintenance = createMaintenance(deps, {
    runs,
    imports,
    billing,
    evals,
    uploads,
  });

  return {
    datasets,
    uploads,
    imports,
    runs,
    billing,
    serving,
    evals,
    maintenance,
  };
};
