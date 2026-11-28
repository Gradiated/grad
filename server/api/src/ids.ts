import { randomBytes } from "node:crypto";

import type { JobKind } from "./store/types.js";

/** Prefixed random identifier, e.g. `run_3f9c0a1b2c3d4e5f60718293`. */
export const newId = (prefix: string): string =>
  `${prefix}_${randomBytes(12).toString("hex")}`;

/** A job's id starts with its kind's prefix (runs are `run_…`). */
const JOB_ID_PREFIX: Readonly<Record<JobKind, string>> = {
  train: "run",
  import: "imp",
  eval: "eval",
};

export const newJobId = (kind: JobKind): string => newId(JOB_ID_PREFIX[kind]);

/** The kind of job `id` names, or null when it names none. */
export const jobKindOf = (id: string): JobKind | null =>
  (Object.keys(JOB_ID_PREFIX) as JobKind[]).find((kind) =>
    id.startsWith(`${JOB_ID_PREFIX[kind]}_`),
  ) ?? null;
