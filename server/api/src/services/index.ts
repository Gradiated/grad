import type { AppDependencies } from "../deps.js";
import {
  createTelemetrySampler,
  type TelemetrySampler,
} from "../telemetry/sampler.js";
import { createDatasetService, type DatasetService } from "./datasets.js";
import { createEvalService, type EvalService } from "./evals/service.js";
import { createEventHub, type EventHub } from "./event-hub.js";
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
  telemetry: TelemetrySampler;
  maintenance: Maintenance;
  /** The replica's SSE fan-out (one LISTEN + safety poll for every stream). */
  events: EventHub;
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
    datasets,
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
  const telemetry = createTelemetrySampler(deps.store, {
    workspaceLabel: deps.settings.metrics?.workspaceLabel === true,
  });
  const maintenance = createMaintenance(deps, {
    telemetry,
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
    telemetry,
    maintenance,
    events: createEventHub(deps.store, {
      pollMs: deps.settings.ssePollMs ?? 2000,
      clock: deps.clock,
    }),
  };
};
