import { randomUUID } from "node:crypto";

import { ApiError } from "./errors.js";

export interface RegisteredEnvWorker {
  workspace_id: string;
  name: string;
  worker_id: string;
  concurrency: number;
  last_heartbeat_at: string;
}

export interface EnvTask {
  id: string;
  workspace_id: string;
  env_name: string;
  task: Record<string, unknown>;
  model_id: string;
  system_prompt: string | null;
  timeout_s: number;
  status: "queued" | "claimed" | "completed" | "failed" | "timed_out";
  worker_id: string | null;
  result: {
    score: number | null;
    scores: Record<string, number>;
    trajectory?: Record<string, unknown>;
    error?: string;
  } | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

export class EnvWorkerHub {
  private readonly workers = new Map<string, RegisteredEnvWorker>();
  private readonly tasks = new Map<string, EnvTask>();
  private readonly waiters = new Map<
    string,
    Array<{ workerId: string; resolve: (task: EnvTask | null) => void }>
  >();

  constructor(
    private readonly workerStaleMs = 60_000,
    private readonly maxStoredTasks = 2000,
    private readonly maxQueuedPerWorkspace = 1000,
  ) {}

  private workerKey = (workspaceId: string, name: string, workerId: string) =>
    `${workspaceId}:${name}:${workerId}`;

  private envKey = (workspaceId: string, name: string) =>
    `${workspaceId}:${name}`;

  private evictOldTerminalTasks = (): void => {
    if (this.tasks.size <= this.maxStoredTasks) return;

    for (const [id, task] of this.tasks.entries()) {
      if (this.tasks.size <= this.maxStoredTasks) break;
      if (
        task.status === "completed" ||
        task.status === "failed" ||
        task.status === "timed_out"
      ) {
        this.tasks.delete(id);
      }
    }
  };

  private expireTimedOutTasks = (): void => {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (
        task.status === "claimed" &&
        task.claimed_at &&
        now - Date.parse(task.claimed_at) > task.timeout_s * 1000
      ) {
        task.status = "timed_out";
        task.completed_at = new Date(now).toISOString();
      }
    }
  };

  register = (
    workspaceId: string,
    name: string,
    workerId: string,
    concurrency: number,
  ): RegisteredEnvWorker => {
    const record: RegisteredEnvWorker = {
      workspace_id: workspaceId,
      name,
      worker_id: workerId,
      concurrency,
      last_heartbeat_at: new Date().toISOString(),
    };

    this.workers.set(this.workerKey(workspaceId, name, workerId), record);

    return record;
  };

  listActiveWorkers = (
    workspaceId: string,
    envName?: string,
  ): RegisteredEnvWorker[] => {
    const cutoff = Date.now() - this.workerStaleMs;
    const active: RegisteredEnvWorker[] = [];

    for (const [key, worker] of this.workers.entries()) {
      if (Date.parse(worker.last_heartbeat_at) < cutoff) {
        this.workers.delete(key);
        continue;
      }

      if (worker.workspace_id !== workspaceId) continue;
      if (envName && worker.name !== envName) continue;

      active.push(worker);
    }

    return active;
  };

  dispatch = (input: {
    workspaceId: string;
    envName: string;
    task: Record<string, unknown>;
    modelId: string;
    systemPrompt?: string;
    timeoutS: number;
  }): EnvTask => {
    let queued = 0;
    for (const task of this.tasks.values()) {
      if (task.workspace_id === input.workspaceId && task.status === "queued") {
        queued += 1;
      }
    }
    if (queued >= this.maxQueuedPerWorkspace) {
      throw new ApiError(
        429,
        "env_queue_full",
        "Too many queued environment tasks",
        `This workspace already has ${queued} queued environment tasks; wait for workers to drain them.`,
      );
    }

    const record: EnvTask = {
      id: `envtask_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      workspace_id: input.workspaceId,
      env_name: input.envName,
      task: input.task,
      model_id: input.modelId,
      system_prompt: input.systemPrompt ?? null,
      timeout_s: input.timeoutS,
      status: "queued",
      worker_id: null,
      result: null,
      created_at: new Date().toISOString(),
      claimed_at: null,
      completed_at: null,
    };

    this.tasks.set(record.id, record);
    this.evictOldTerminalTasks();

    const queue = this.waiters.get(
      this.envKey(input.workspaceId, input.envName),
    );
    const waiter = queue?.shift();
    if (waiter) {
      this.markClaimed(record, waiter.workerId);
      waiter.resolve(record);
    }

    return record;
  };

  claim = async (
    workspaceId: string,
    envName: string,
    workerId: string,
    waitMs = 0,
    signal?: AbortSignal,
  ): Promise<EnvTask | null> => {
    this.expireTimedOutTasks();
    const worker = this.workers.get(
      this.workerKey(workspaceId, envName, workerId),
    );
    if (worker) {
      worker.last_heartbeat_at = new Date().toISOString();
    }

    const immediate = this.findNextQueued(workspaceId, envName);
    if (immediate) return this.markClaimed(immediate, workerId);

    if (waitMs <= 0) return null;

    return new Promise<EnvTask | null>((resolve) => {
      const key = this.envKey(workspaceId, envName);
      const list = this.waiters.get(key) ?? [];
      this.waiters.set(key, list);

      const entry = {
        workerId,
        resolve: (task: EnvTask | null) => {
          clearTimeout(timer);
          resolve(task);
        },
      };

      const drop = () => {
        clearTimeout(timer);
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
        resolve(null);
      };
      const timer = setTimeout(drop, waitMs);
      signal?.addEventListener("abort", drop, { once: true });

      list.push(entry);
    });
  };

  private findNextQueued = (
    workspaceId: string,
    envName: string,
  ): EnvTask | undefined => {
    for (const task of this.tasks.values()) {
      if (
        task.workspace_id === workspaceId &&
        task.env_name === envName &&
        task.status === "queued"
      ) {
        return task;
      }
    }

    return undefined;
  };

  private markClaimed = (task: EnvTask, workerId: string): EnvTask => {
    task.status = "claimed";
    task.worker_id = workerId;
    task.claimed_at = new Date().toISOString();

    return task;
  };

  complete = (
    workspaceId: string,
    taskId: string,
    input: {
      worker_id: string;
      score?: number | null | undefined;
      scores: Record<string, number>;
      trajectory?: Record<string, unknown> | undefined;
      error?: string | undefined;
    },
  ): EnvTask | null => {
    const task = this.tasks.get(taskId);
    if (
      !task ||
      task.workspace_id !== workspaceId ||
      task.status !== "claimed" ||
      task.worker_id !== input.worker_id
    ) {
      return null;
    }

    task.status = input.error ? "failed" : "completed";
    task.completed_at = new Date().toISOString();
    task.result = {
      score: input.score ?? null,
      scores: input.scores,
      ...(input.trajectory !== undefined
        ? { trajectory: input.trajectory }
        : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };

    return task;
  };

  getTask = (workspaceId: string, taskId: string): EnvTask | null => {
    const task = this.tasks.get(taskId);
    if (!task || task.workspace_id !== workspaceId) return null;

    return task;
  };
}
