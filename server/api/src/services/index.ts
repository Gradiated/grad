import type { AppDependencies } from "../deps.js";
import { createDatasetService, type DatasetService } from "./datasets.js";
import { createEvalService, type EvalService } from "./evals/service.js";
import { createImportService, type ImportService } from "./imports.js";
import { createJobQueue, type JobQueue } from "./jobs.js";
import { createMaintenance, type Maintenance } from "./maintenance.js";
import { createRunLifecycle, type RunLifecycle } from "./runs.js";
import { createSourceService, type SourceService } from "./sources.js";
import { createUploadService, type UploadService } from "./uploads.js";
import { createUsageService, type UsageService } from "./usage.js";

export interface Services {
  datasets: DatasetService;
  uploads: UploadService;
  imports: ImportService;
  runs: RunLifecycle;
  usage: UsageService;
  evals: EvalService;
  queue: JobQueue;
  sources: SourceService;
  maintenance: Maintenance;
}

export const createServices = (deps: AppDependencies): Services => {
  // The queue calls back into each kind's handler, and the kinds use the
  // queue: they reach it through this getter.
  let queue: JobQueue | null = null;
  const getQueue = (): JobQueue => {
    if (!queue) throw new Error("The job queue is not wired yet.");
    return queue;
  };

  const datasets = createDatasetService(deps);
  const uploads = createUploadService(deps);
  const usage = createUsageService(deps);
  const sources = createSourceService(deps, { queue: getQueue });
  const imports = createImportService(deps, {
    uploads,
    sources,
    queue: getQueue,
  });
  const evals = createEvalService(deps, { datasets, usage, queue: getQueue });
  const runs = createRunLifecycle(deps, {
    datasets,
    uploads,
    usage,
    evals,
    queue: getQueue,
  });
  queue = createJobQueue(deps, {
    train: runs.handler,
    import: imports.handler,
    eval: evals.handler,
  });
  const maintenance = createMaintenance(deps, {
    queue,
    runs,
    evals,
    uploads,
    usage,
    sources,
  });

  return {
    datasets,
    uploads,
    imports,
    runs,
    usage,
    evals,
    queue,
    sources,
    maintenance,
  };
};
