import type { AppDependencies } from "../deps.js";
import {
  createArtifactImportService,
  type ArtifactImportService,
} from "./artifact-imports.js";
import { createArtifactService, type ArtifactService } from "./artifacts.js";
import {
  createCheckpointService,
  type CheckpointService,
} from "./checkpoints.js";
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
import { createSecretService, type SecretService } from "./secrets.js";
import { createSourceService, type SourceService } from "./sources.js";
import { createUploadService, type UploadService } from "./uploads.js";
import { createUsageService, type UsageService } from "./usage.js";
import {
  createWorkspaceLifecycle,
  type WorkspaceLifecycle,
} from "./workspaces.js";

export interface Services {
  datasets: DatasetService;
  uploads: UploadService;
  imports: ImportService;
  artifacts: ArtifactService;
  checkpoints: CheckpointService;
  artifactImports: ArtifactImportService;
  runs: RunLifecycle;
  usage: UsageService;
  evals: EvalService;
  queue: JobQueue;
  sources: SourceService;
  secrets: SecretService;
  telemetry: TelemetrySampler;
  maintenance: Maintenance;
  /** The replica's SSE fan-out (one LISTEN + safety poll for every stream). */
  events: EventHub;
  /** Cloud's workspace lifecycle hooks (suspend, reinstate, delete and purge). */
  workspaces: WorkspaceLifecycle;
}

export const createServices = (deps: AppDependencies): Services => {
  const datasets = createDatasetService(deps);
  const uploads = createUploadService(deps);
  const usage = createUsageService(deps);
  const secrets = createSecretService(deps);
  const sources = createSourceService(deps, { secrets });
  const artifacts = createArtifactService(deps);
  const checkpoints = createCheckpointService(deps);
  const artifactImports = createArtifactImportService(deps, {
    uploads,
    secrets,
  });
  const imports = createImportService(deps, {
    uploads,
    sources,
    secrets,
    datasets,
    artifactImports,
  });
  const evals = createEvalService(deps, { datasets, usage });
  const runs = createRunLifecycle(deps, {
    datasets,
    uploads,
    usage,
    evals,
    checkpoints,
    secrets,
  });
  const queue = createJobQueue(deps, {
    train: runs.handler,
    import: imports.handler,
    eval: evals.handler,
  });
  const telemetry = createTelemetrySampler(deps.store, {
    workspaceLabel: deps.settings.metrics?.workspaceLabel === true,
    maxRunning: deps.settings.queue.maxRunning,
  });
  const workspaces = createWorkspaceLifecycle(deps, { runs, evals });
  const maintenance = createMaintenance(deps, {
    workspaces,
    telemetry,
    queue,
    runs,
    checkpoints,
    evals,
    uploads,
    usage,
    sources,
    secrets,
  });

  return {
    datasets,
    uploads,
    imports,
    artifacts,
    checkpoints,
    artifactImports,
    runs,
    usage,
    evals,
    queue,
    sources,
    secrets,
    telemetry,
    maintenance,
    workspaces,
    events: createEventHub(deps.store, {
      pollMs: deps.settings.ssePollMs,
      clock: deps.clock,
    }),
  };
};
