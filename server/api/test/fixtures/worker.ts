import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { TRAINER_KEY, type TestApp } from "./app.js";

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

export interface ClaimedJob {
  id: string;
  kind: "train" | "import";
  attempt: number;
  lease_seconds: number;
  max_cost_usd: number | null;
  price_per_million_tokens: number | null;
  run: {
    id: string;
    resolved_config: Record<string, unknown>;
    recipe_kind: string;
  } | null;
  import: {
    id: string;
    source: Record<string, unknown>;
    dataset: string;
  } | null;
  dataset: {
    version: number;
    record_count: number;
    download_url: string;
  } | null;
  resume: { checkpoint_id: string; step: number; download_url: string } | null;
}

/** Drives the trainer worker protocol over HTTP, like grad_trainer.worker does. */
export class FakeWorker {
  constructor(
    private readonly t: TestApp,
    readonly workerId = "worker-1",
    private readonly token: string = TRAINER_KEY,
  ) {}

  call = <T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    method?: string,
  ) =>
    this.t.json<T>(path, {
      token: this.token,
      ...(body !== undefined ? { body } : {}),
      ...(method ? { method } : {}),
    });

  claim = async (
    extra: Record<string, unknown> = {},
  ): Promise<ClaimedJob | null> => {
    const res = await this.call<{ job: ClaimedJob | null }>(
      "/v1/trainer-jobs/claim",
      {
        worker_id: this.workerId,
        lease_seconds: 60,
        ...extra,
      },
    );
    if (res.status !== 200)
      throw new Error(
        `claim failed ${res.status}: ${JSON.stringify(res.body)}`,
      );

    return res.body.job;
  };

  ref = (job: ClaimedJob) => ({
    worker_id: this.workerId,
    attempt: job.attempt,
  });

  heartbeat = (job: ClaimedJob) =>
    this.call(`/v1/trainer-jobs/${job.id}/heartbeat`, this.ref(job));

  progress = (
    job: ClaimedJob,
    step: number,
    tokens: number,
    extra: Record<string, unknown> = {},
  ) =>
    this.call<{
      should_stop: boolean;
      stop_reason: string | null;
      cost_usd: number;
      status: string;
    }>(`/v1/trainer-jobs/${job.id}/progress`, {
      ...this.ref(job),
      metric: {
        step,
        loss: 1 / (step + 1),
        tokens,
        timestamp: this.t.clock.now().toISOString(),
        ...extra,
      },
    });

  /** Requests an upload ticket and PUTs `bytes` to it; returns the upload id. */
  upload = async (
    job: ClaimedJob,
    kind: "checkpoint" | "artifact",
    bytes: Uint8Array | string,
  ) => {
    const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    const ticket = await this.call<{
      upload_id: string;
      url: string;
      headers: Record<string, string>;
    }>(`/v1/trainer-jobs/${job.id}/uploads`, {
      ...this.ref(job),
      kind,
      sha256: sha256Hex(data),
      size_bytes: data.byteLength,
    });
    if (ticket.status !== 201)
      throw new Error(`upload ticket failed: ${JSON.stringify(ticket.body)}`);

    const put = await (
      ticket.body.url.startsWith("http") ? fetch : this.t.app.request
    )(ticket.body.url, {
      method: "PUT",
      headers: ticket.body.headers,
      body: new Uint8Array(data),
    });
    if (put.status !== 200)
      throw new Error(`PUT failed ${put.status}: ${await put.text()}`);

    return ticket.body.upload_id;
  };

  checkpoint = async (
    job: ClaimedJob,
    step: number,
    bytes: string,
    extra: Record<string, unknown> = {},
  ) => {
    const uploadId = await this.upload(job, "checkpoint", bytes);

    return this.call<Record<string, unknown>>(
      `/v1/trainer-jobs/${job.id}/checkpoints`,
      {
        ...this.ref(job),
        step,
        eval_score: 0.5,
        upload_id: uploadId,
        metadata: { note: `step-${step}` },
        ...extra,
      },
    );
  };

  complete = async (
    job: ClaimedJob,
    body: Record<string, unknown> & { status: string },
    artifactBytes?: string,
  ) => {
    const uploadId = artifactBytes
      ? await this.upload(job, "artifact", artifactBytes)
      : undefined;

    return this.call<{
      status: string;
      run: Record<string, unknown> | null;
      artifact: Record<string, unknown> | null;
      import: Record<string, unknown> | null;
    }>(`/v1/trainer-jobs/${job.id}/complete`, {
      ...this.ref(job),
      ...(uploadId ? { upload_id: uploadId } : {}),
      ...body,
    });
  };

  downloadDataset = async (
    job: ClaimedJob,
  ): Promise<Array<Record<string, unknown>>> => {
    const res = await this.t.request(job.dataset?.download_url ?? "", {
      token: this.token,
    });
    if (res.status !== 200)
      throw new Error(`dataset download failed ${res.status}`);
    // gzip-compressed JSONL: the stored parts, back to back.
    const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString(
      "utf8",
    );

    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
}

export const sftRecords = (n: number, prefix = "q") =>
  Array.from({ length: n }, (_, i) => ({
    session_id: `s${i}`,
    messages: [
      { role: "user", content: `${prefix} ${i}?` },
      { role: "assistant", content: `answer ${i}` },
    ],
  }));

/** Pushes a dataset and creates an SFT run on the tiny test model. */
export const createSftRun = async (
  t: TestApp,
  options: {
    dataset?: string;
    name?: string;
    maxCostUsd?: number;
    token?: string;
    records?: number;
  } = {},
) => {
  const dataset = options.dataset ?? "support";
  const token = options.token;
  await t.json(`/v1/datasets/${dataset}/records`, {
    body: { records: sftRecords(options.records ?? 20) },
    ...(token ? { token } : {}),
  });
  const res = await t.json<Record<string, unknown> & { id: string }>(
    "/v1/runs",
    {
      body: {
        dataset,
        name: options.name ?? "support-sft",
        recipe: { kind: "sft", model: "test/tiny-qwen3", batch_size: 4 },
        ...(options.maxCostUsd !== undefined
          ? { max_cost_usd: options.maxCostUsd }
          : {}),
      },
      ...(token ? { token } : {}),
    },
  );
  if (res.status !== 202)
    throw new Error(
      `create run failed ${res.status}: ${JSON.stringify(res.body)}`,
    );

  return res.body;
};
