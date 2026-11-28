import type {
  Artifact as ArtifactData,
  ArtifactDownloadUrl,
  ArtifactImport as ArtifactImportData,
  CreateArtifactImportRequest,
  ImportableArtifactFormat,
} from "../generated/models.js";
import { GradError, type RawResponse, type RequestOptions, type StreamOptions } from "../transport.js";
import { isNodeRuntime, type Core } from "../core.js";
import { ArtifactImportFailedError, GradUsageError } from "../errors.js";
import { Paginator } from "../pagination.js";
import { Pending } from "../pending.js";
import { pollUntil, type WaitOptions } from "../polling.js";

export type ArtifactRef = string | { id: string } | { name: string; version: string };

/** `name@version` for Artifact objects, the string itself otherwise. */
export const artifactRef = (ref: ArtifactRef): string => {
  if (typeof ref === "string") return ref;
  if ("version" in ref && "name" in ref) return `${ref.name}@${ref.version}`;
  return (ref as { id: string }).id;
};

export interface ArtifactUploadOptions extends RequestOptions {
  /** The catalog base model the files were trained on (GET /v1/base-models). */
  base: string;
  /** Default `peft_lora`. */
  format?: ImportableArtifactFormat;
  /** Artifact name (default: the file or directory name). */
  name?: string;
}

export interface ArtifactFromHfOptions extends Omit<ArtifactUploadOptions, "name"> {
  /** Artifact name (default: the repo's name). */
  name?: string;
  /** Branch, tag or commit (or `hf://owner/name@revision`); the import pins the commit. */
  revision?: string;
  /** Workspace secret holding an HF token (gated or private repos). */
  secret?: string;
}

export interface DownloadOptions extends StreamOptions {
  /** Verify `X-Artifact-Sha256` (default true). Disable only for debugging. */
  verifyChecksum?: boolean;
  /**
   * Write the bundle's files (for an LLM artifact, the PEFT adapter vLLM and SGLang load) into
   * `dest`, a directory that must not exist or be empty, instead of the `.grad.tar.gz`. Every
   * file is checked against the manifest's SHA-256; on failure `dest` is left as it was.
   */
  extract?: boolean;
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

const HF_URI = /^(?:hf:\/\/)?([A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)?)(?:@([^@\s]+))?$/;

/** `{ repo, revision }` of `hf://owner/name[@revision]` (or `owner/name`). */
export const parseHfUri = (uri: string, revision?: string): { repo: string; revision: string | undefined } => {
  const match = HF_URI.exec(uri.trim());
  if (!match?.[1] || match[1].includes("..")) {
    throw new GradUsageError(`'${uri}' is not a Hugging Face repo: use hf://owner/name or hf://owner/name@revision.`, "invalid_hf_uri");
  }
  if (match[2] && revision && match[2] !== revision) {
    throw new GradUsageError(`'${uri}' pins revision '${match[2]}', but revision '${revision}' was passed too.`, "invalid_hf_uri");
  }
  return { repo: match[1], revision: match[2] ?? revision };
};

/** The default upload name: the file or directory name as a slug. */
export const artifactName = (path: string): string => {
  const base = (path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "").replace(/(\.grad)?\.(tar\.gz|tgz|tar)$/, "");
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+/, "").slice(0, 64).replace(/[-._]+$/, "");
  return slug || "upload";
};

/** An upload or HF import an import worker validates and releases; `wait()` returns the Artifact. */
export interface ArtifactImport extends ArtifactImportData {}
export class ArtifactImport {
  readonly #core: Core;

  constructor(core: Core, data: ArtifactImportData) {
    this.#core = core;
    Object.assign(this, data);
  }

  async refresh(options?: RequestOptions): Promise<this> {
    Object.assign(this, await this.#core.api.getArtifactImport(this.id, options));
    return this;
  }

  /** Polls until the import finishes; throws ArtifactImportFailedError (`invalid_artifact`, 422) on failure. */
  async wait(options: WaitOptions = {}): Promise<Artifact> {
    const done = await pollUntil(
      `artifact import ${this.id}`,
      (signal) => this.#core.api.getArtifactImport(this.id, { signal }),
      (job) => job.status === "completed" || job.status === "failed",
      options,
      this.#core.poll,
    );
    Object.assign(this, done);
    if (done.status === "failed" || !done.artifactId) throw new ArtifactImportFailedError(done);
    return new Artifact(this.#core, await this.#core.api.getArtifact(done.artifactId, { signal: options.signal }));
  }

  toJSON(): ArtifactImportData {
    return { ...this } as ArtifactImportData;
  }
}

export type PendingArtifactImport = Pending<ArtifactImport, Artifact, WaitOptions>;

const createImport = async (core: Core, body: CreateArtifactImportRequest, request: RequestOptions): Promise<ArtifactImport> =>
  new ArtifactImport(core, await core.api.createArtifactImport(body, request));

const uploadArtifact = async (core: Core, path: string, options: ArtifactUploadOptions): Promise<ArtifactImport> => {
  if (!isNodeRuntime()) throw new GradUsageError("artifacts.upload reads files from disk and needs Node.js.", "node_only");
  const { base, format = "peft_lora", name, ...request } = options;
  const { describeFile, packArtifact } = await import("../node/files.js");
  const packed = await packArtifact(path);
  try {
    const file = await describeFile(packed.path);
    const ticket = await core.api.createUpload(
      { purpose: "artifact_import", filename: file.filename, sizeBytes: file.sizeBytes, sha256: file.sha256 },
      request,
    );
    const put = await core.upload(ticket.url, ticket.headers, { path: file.path, sizeBytes: file.sizeBytes }, request);
    await put.cancel();
    return await createImport(
      core,
      { source: { kind: "upload", uploadId: ticket.uploadId }, baseModel: base, format, name: name ?? artifactName(path) },
      request,
    );
  } finally {
    await packed.cleanup();
  }
};

const importHf = (core: Core, uri: string, options: ArtifactFromHfOptions): Promise<ArtifactImport> => {
  const { base, format = "peft_lora", name, revision, secret, ...request } = options;
  const parsed = parseHfUri(uri, revision);
  return createImport(
    core,
    {
      source: {
        kind: "hf",
        repo: parsed.repo,
        ...(parsed.revision !== undefined ? { revision: parsed.revision } : {}),
        ...(secret !== undefined ? { secret } : {}),
      },
      baseModel: base,
      format,
      ...(name !== undefined ? { name } : {}),
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
  const { verifyChecksum = true, extract = false, ...request } = options;
  const { checkExtractDest, extractInto, streamToFile } = await import("../node/files.js");
  if (extract) await checkExtractDest(dest);
  const opened = await openArtifact(core, ref, request);
  if (verifyChecksum && opened.sha256 === undefined) {
    await opened.response.cancel();
    throw new GradError(
      `Artifact ${ref} download has no valid X-Artifact-Sha256 header, so it cannot be verified. Pass verifyChecksum: false only if you trust the transport.`,
      { code: "missing_checksum", requestId: opened.response.requestId },
    );
  }
  if (!extract) return streamToFile(opened.response, dest, ref, verifyChecksum ? opened.sha256 : undefined);
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const parent = path.dirname(path.resolve(dest));
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, ".grad-download-"));
  try {
    const bundle = await streamToFile(opened.response, path.join(scratch, "bundle.grad.tar.gz"), ref, verifyChecksum ? opened.sha256 : undefined);
    await extractInto(bundle.path, dest);
    return { ...bundle, path: dest };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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

  /** Deletes this artifact and its bundle (ConflictError `artifact_pinned` while a published model version pins it). */
  async delete(options?: RequestOptions): Promise<void> {
    await this.#core.api.deleteArtifact(this.id, options);
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

  /** Artifacts, newest first; `name` keeps one name's versions, `search` names containing it (any case) or the exact id. */
  list(options: { name?: string; search?: string; limit?: number } & RequestOptions = {}): Paginator<Artifact> {
    const { name, search, limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listArtifacts({ name, q: search, limit, cursor }, request);
      return { data: page.data.map((a) => new Artifact(this.core, a)), nextCursor: page.nextCursor };
    }, request.signal);
  }

  download(ref: ArtifactRef, dest: string, options?: DownloadOptions): Promise<DownloadResult> {
    return downloadArtifact(this.core, artifactRef(ref), dest, options);
  }

  /**
   * A presigned URL of the bundle (valid 15 minutes): a browser downloads it straight from
   * storage (`<a href>`) instead of holding the artifact in memory. Verify `sha256`.
   */
  downloadUrl(ref: ArtifactRef, options?: RequestOptions): Promise<ArtifactDownloadUrl> {
    return this.core.api.getArtifactDownloadUrl(artifactRef(ref), options);
  }

  /**
   * Registers local weights (a directory, a file or a `.tar.gz`) as an artifact. An import
   * worker checks them against the format spec and `base` (for `peft_lora`: the adapter
   * config, base model and revision, target modules and every tensor shape); `.wait()`
   * returns the Artifact or throws ArtifactImportFailedError (`invalid_artifact`, 422).
   */
  upload(path: string, options: ArtifactUploadOptions): PendingArtifactImport {
    return new Pending(uploadArtifact(this.core, path, options));
  }

  /** Imports weights from the Hugging Face Hub (`hf://owner/name[@revision]`), pinned to the commit; same checks as `upload`. */
  fromHf(uri: string, options: ArtifactFromHfOptions): PendingArtifactImport {
    return new Pending(importHf(this.core, uri, options));
  }

  /** An upload or HF import. */
  async getImport(id: string, options?: RequestOptions): Promise<ArtifactImport> {
    return new ArtifactImport(this.core, await this.core.api.getArtifactImport(id, options));
  }

  /** Polls an upload or HF import until it finishes; the same as `(await getImport(id)).wait()`. */
  async waitImport(id: string, options: WaitOptions = {}): Promise<Artifact> {
    return (await this.getImport(id, { signal: options.signal })).wait(options);
  }

  /** Deletes an artifact and its bundle (ConflictError `artifact_pinned` while pinned). */
  async delete(ref: ArtifactRef, options?: RequestOptions): Promise<void> {
    await this.core.api.deleteArtifact(artifactRef(ref), options);
  }

  stream(ref: ArtifactRef, options?: StreamOptions): Promise<ArtifactStream> {
    return openArtifact(this.core, artifactRef(ref), options);
  }
}
