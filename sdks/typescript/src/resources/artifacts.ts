import type {
  Artifact as ArtifactData,
  ChatMessage,
  Deployment,
  DeploymentStatus,
  EmbedResponse,
  FeedbackEventInput,
  RecordFeedbackResponse,
  RouteResponse,
} from "../generated/models.js";
import { GradError, type RawResponse, type RequestOptions, type StreamOptions } from "../generated/transport.js";
import { isNodeRuntime, type Core } from "../core.js";
import { GradUsageError } from "../errors.js";
import { Paginator } from "../pagination.js";

export type ArtifactRef = string | { id: string } | { name: string; version: string };

/** `name@version` for Artifact objects, the string itself otherwise. */
export const artifactRef = (ref: ArtifactRef): string => {
  if (typeof ref === "string") return ref;
  if ("version" in ref && "name" in ref) return `${ref.name}@${ref.version}`;
  return (ref as { id: string }).id;
};

export interface DeployOptions extends RequestOptions {
  /** Deployment name (default: the artifact name). */
  name?: string;
  /** Model that serves traffic when a router can't, or after a rollback. */
  fallback?: string;
  /** Share of traffic routed to exploration (routers). */
  exploreRate?: number;
}

export interface DownloadOptions extends StreamOptions {
  /** Verify `X-Artifact-Sha256` (default true). Disable only for debugging. */
  verifyChecksum?: boolean;
}

export interface ArtifactStream {
  /** The bundle bytes (`.grad.tar.gz`), streamed. */
  body: ReadableStream<Uint8Array>;
  /** Lower-case hex SHA-256 the server declared (undefined when missing or malformed). */
  sha256: string | undefined;
  sizeBytes: number | undefined;
  filename: string | undefined;
  response: RawResponse;
}

const HEX64 = /^[0-9a-f]{64}$/;

export const deployArtifact = async (core: Core, ref: ArtifactRef, options: DeployOptions = {}): Promise<Deployment> => {
  const { name, fallback, exploreRate, ...request } = options;
  return core.api.deployArtifact(
    {
      artifact: artifactRef(ref),
      ...(name !== undefined ? { name } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
      ...(exploreRate !== undefined ? { exploreRate } : {}),
    },
    request,
  );
};

export const openArtifact = async (core: Core, ref: string, options?: StreamOptions): Promise<ArtifactStream> => {
  const response = await core.api.downloadArtifact(ref, options);
  const declared = response.headers.get("x-artifact-sha256")?.trim().toLowerCase();
  const length = response.headers.get("content-length");
  const disposition = response.headers.get("content-disposition");
  return {
    body: response.body,
    sha256: declared && HEX64.test(declared) ? declared : undefined,
    sizeBytes: length !== null && /^\d+$/.test(length) ? Number(length) : undefined,
    filename: disposition ? /filename="?([^";]+)"?/i.exec(disposition)?.[1] : undefined,
    response,
  };
};

export interface DownloadResult {
  path: string;
  sha256: string;
  sizeBytes: number;
}

/** Streams an artifact to disk with SHA-256 verification (Node only). */
export const downloadArtifact = async (core: Core, ref: string, dest: string, options: DownloadOptions = {}): Promise<DownloadResult> => {
  if (!isNodeRuntime()) {
    throw new GradUsageError("artifacts.download writes to disk and needs Node.js; use artifacts.stream() in a browser.", "node_only");
  }
  const { verifyChecksum = true, ...request } = options;
  const { streamToFile } = await import("../node/files.js");
  const opened = await openArtifact(core, ref, request);
  if (verifyChecksum && opened.sha256 === undefined) {
    await opened.response.cancel();
    throw new GradError(
      `Artifact ${ref} download has no valid X-Artifact-Sha256 header, so it cannot be verified. Pass verifyChecksum: false only if you trust the transport.`,
      { code: "missing_checksum", requestId: opened.response.requestId },
    );
  }
  return streamToFile(opened.response, dest, ref, verifyChecksum ? opened.sha256 : undefined);
};

/** An immutable, versioned training output (`name@YYYY-MM-DD-n`). */
export interface Artifact extends ArtifactData {}
export class Artifact {
  readonly #core: Core;

  constructor(core: Core, data: ArtifactData) {
    this.#core = core;
    Object.assign(this, data);
  }

  /** `name@version`. */
  get ref(): string {
    return `${this.name}@${this.version}`;
  }

  /** Points `your-org/<name>` at this version (Cloud; self-hosted servers raise DeployUnavailableError). */
  async deploy(options?: DeployOptions): Promise<Deployment> {
    return deployArtifact(this.#core, this.id, options);
  }

  /** Streams the bundle to `dest` (a file, or a directory for the server's file name), verifying SHA-256. */
  async download(dest: string, options?: DownloadOptions): Promise<DownloadResult> {
    return downloadArtifact(this.#core, this.id, dest, options);
  }

  /** The raw bundle stream plus the declared checksum (browser-safe). */
  stream(options?: StreamOptions): Promise<ArtifactStream> {
    return openArtifact(this.#core, this.id, options);
  }

  toJSON(): ArtifactData {
    return { ...this } as ArtifactData;
  }
}

export class ArtifactsResource {
  constructor(private readonly core: Core) {}

  /** By id, `name@version` or `name@latest`. */
  async get(ref: string, options?: RequestOptions): Promise<Artifact> {
    return new Artifact(this.core, await this.core.api.getArtifact(ref, options));
  }

  list(options: { name?: string; limit?: number } & RequestOptions = {}): Paginator<Artifact> {
    const { name, limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listArtifacts(
        { ...(name !== undefined ? { name } : {}), ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) },
        request,
      );
      return { data: page.data.map((a) => new Artifact(this.core, a)), nextCursor: page.nextCursor };
    }, request.signal);
  }

  download(ref: ArtifactRef, dest: string, options?: DownloadOptions): Promise<DownloadResult> {
    return downloadArtifact(this.core, artifactRef(ref), dest, options);
  }

  stream(ref: ArtifactRef, options?: StreamOptions): Promise<ArtifactStream> {
    return openArtifact(this.core, artifactRef(ref), options);
  }
}

export class DeploymentsResource {
  constructor(private readonly core: Core) {}

  /** Deploys an artifact; deploying an earlier version is a rollback. */
  create(artifact: ArtifactRef, options?: DeployOptions): Promise<Deployment> {
    return deployArtifact(this.core, artifact, options);
  }

  get(name: string, options?: RequestOptions): Promise<DeploymentStatus> {
    return this.core.api.getDeployment(name, options);
  }

  list(options: { limit?: number } & RequestOptions = {}): Paginator<Deployment> {
    const { limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listDeployments({ ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) }, request);
      return { data: page.data, nextCursor: page.nextCursor };
    }, request.signal);
  }

  /** Re-points the deployment at its previous artifact. */
  rollback(name: string, options?: RequestOptions): Promise<Deployment> {
    return this.core.api.rollbackDeployment(name, options);
  }
}

export interface FeedbackEvent {
  inferenceId?: string;
  sessionId?: string;
  deploymentName?: string;
  /** Dedupe key (default: the inference id, else a random UUID). */
  idempotencyKey?: string;
  score?: number;
  expectedOutput?: unknown;
  metrics?: Record<string, number>;
}

const randomId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
};

const toWireEvent = (event: FeedbackEvent): FeedbackEventInput => {
  if (event.score !== undefined && (!Number.isFinite(event.score) || event.score < 0 || event.score > 1)) {
    throw new GradUsageError(`Feedback score must be in [0, 1] (got ${event.score}).`, "invalid_feedback");
  }
  return {
    idempotencyKey: event.idempotencyKey ?? event.inferenceId ?? randomId(),
    ...(event.inferenceId !== undefined ? { inferenceId: event.inferenceId } : {}),
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    ...(event.deploymentName !== undefined ? { deploymentName: event.deploymentName } : {}),
    ...(event.score !== undefined ? { score: event.score } : {}),
    ...(event.expectedOutput !== undefined ? { expectedOutput: event.expectedOutput } : {}),
    ...(event.metrics !== undefined ? { metrics: event.metrics } : {}),
  };
};

export class FeedbackResource {
  constructor(private readonly core: Core) {}

  /** Records one outcome (or several); duplicates by idempotency key are ignored server-side. */
  async record(events: FeedbackEvent | FeedbackEvent[], options?: RequestOptions): Promise<RecordFeedbackResponse> {
    const list = Array.isArray(events) ? events : [events];
    if (list.length === 0) throw new GradUsageError("feedback.record needs at least one event.", "invalid_feedback");
    return this.core.api.recordFeedback({ events: list.map(toWireEvent) }, options);
  }
}

/** A router's choice for one request; call the model yourself, then `recordFeedback`. */
export interface RouteDecision extends RouteResponse {}
export class RouteDecision {
  readonly #core: Core;

  constructor(core: Core, data: RouteResponse) {
    this.#core = core;
    Object.assign(this, data);
  }

  /** Records the outcome of this decision (linked by inference id and deployment). */
  recordFeedback(event: Omit<FeedbackEvent, "inferenceId" | "deploymentName"> = {}, options?: RequestOptions): Promise<RecordFeedbackResponse> {
    return new FeedbackResource(this.#core).record({ ...event, inferenceId: this.inferenceId, deploymentName: this.deployment }, options);
  }

  toJSON(): RouteResponse {
    return { ...this } as RouteResponse;
  }
}

export interface RouteInput extends RequestOptions {
  messages: ChatMessage[];
  tools?: Array<Record<string, unknown>> | unknown[];
  sessionId?: string;
}

export const route = async (core: Core, deployment: string, input: RouteInput): Promise<RouteDecision> => {
  const { messages, tools, sessionId, ...request } = input;
  const data = await core.api.routeRequest(
    {
      deployment,
      messages,
      ...(tools !== undefined ? { tools: tools as Array<Record<string, unknown>> } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
    request,
  );
  return new RouteDecision(core, data);
};

export class EmbeddingsResource {
  constructor(private readonly core: Core) {}

  /** Embeds text with a deployed embedding model (Cloud). */
  create(input: { model: string; input: string | string[] }, options?: RequestOptions): Promise<EmbedResponse> {
    return this.core.api.createEmbeddings(input, options);
  }
}
