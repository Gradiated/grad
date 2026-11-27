import { GradError } from "./transport.js";
import type { EvalRun, ImportJob, Run } from "./generated/models.js";

export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  DeployUnavailableError,
  GradError,
  InferenceUnavailableError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  RedirectError,
  ResponseDecodeError,
  ServerError,
  ValidationError,
  type FieldError,
} from "./transport.js";

/** A run ended `failed`, `cancelled` or `stopped_budget`; `run` holds its final state. */
export class RunFailedError extends GradError {
  readonly run: Run;

  constructor(run: Run) {
    const reason = run.error ? `: ${run.error}` : "";
    const hint =
      run.status === "stopped_budget"
        ? " Raise the cap and continue with grad.runs.resume(id, { maxCostUsd })."
        : "";
    super(`Run ${run.id} (${run.name}) ended ${run.status}${reason}.${hint}`, {
      code: `run_${run.status}`,
    });
    this.run = run;
  }
}

/** An eval ended `failed` or `cancelled`. */
export class EvalFailedError extends GradError {
  readonly eval: EvalRun;

  constructor(evalRun: EvalRun) {
    super(
      `Eval ${evalRun.id} (${evalRun.name}) ended ${evalRun.status}${evalRun.error ? `: ${evalRun.error}` : ""}.`,
      { code: `eval_${evalRun.status}` },
    );
    this.eval = evalRun;
  }
}

/** A dataset import ended `failed`. */
export class ImportFailedError extends GradError {
  readonly job: ImportJob;

  constructor(job: ImportJob) {
    super(
      `Import ${job.id} into dataset '${job.dataset}' failed${job.error ? `: ${job.error}` : ""}.`,
      { code: "import_failed" },
    );
    this.job = job;
  }
}

/** `wait()` gave up after its `timeoutMs`; the resource keeps running server-side. */
export class WaitTimeoutError extends GradError {
  constructor(what: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms waiting for ${what}; it keeps running on the server.`, {
      code: "wait_timeout",
    });
  }
}

/** A downloaded artifact's SHA-256 did not match `X-Artifact-Sha256`; nothing was written. */
export class ChecksumMismatchError extends GradError {
  readonly expected: string;
  readonly actual: string;

  constructor(reference: string, expected: string, actual: string) {
    super(`Artifact ${reference} failed SHA-256 verification: expected ${expected}, got ${actual}. The partial file was removed.`, {
      code: "checksum_mismatch",
    });
    this.expected = expected;
    this.actual = actual;
  }
}

/** The server returned a cursor it already returned in this listing; following it would never end. */
export class PaginationLoopError extends GradError {
  readonly cursor: string;

  constructor(cursor: string) {
    super(`Pagination loop: the server repeated cursor '${cursor}'; stopping instead of fetching forever.`, {
      code: "pagination_loop",
    });
    this.cursor = cursor;
  }
}

/** The SDK was used in a way it cannot support (bad options, Node-only feature in a browser, ...). */
export class GradUsageError extends GradError {
  constructor(message: string, code = "usage_error") {
    super(message, { code });
  }
}
