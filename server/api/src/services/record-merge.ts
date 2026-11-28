import type { DatasetRecord } from "../contracts.js";

/**
 * Dataset parts are immutable, so later facts about a record arrive as more
 * records: a score update (`metadata.score_update: true`, an `id` plus
 * `scores` and/or `expected_output`, no content) from `dataset.score()` or a
 * source sync, or the same `id` again with new content. `mergeRecords` folds
 * a version's records, in part order, into one record per id (the rule of
 * `grad_trainer/records.py::merge_records`):
 * - first-seen order; later content replaces earlier content;
 * - scores merge per name, later wins; `expected_output` survives a content
 *   update that has none;
 * - an update for an id that never arrives is dropped;
 * - a reset marker (`metadata.dataset_reset: true`, from a full source
 *   resync) drops everything before it;
 * - records without an id pass through unchanged;
 * - a record with a `metadata.score_filter` (a source's `has_feedback` /
 *   `min_score`, which can't be judged until feedback arrives) is kept only
 *   once its merged scores pass, and loses the key.
 */
const SCORE_UPDATE = "score_update";
export const SCORE_FILTER = "score_filter";

const meta = (record: DatasetRecord): Record<string, unknown> | undefined =>
  record.metadata;

export const isScoreUpdate = (record: DatasetRecord): boolean =>
  meta(record)?.[SCORE_UPDATE] === true;

export const isReset = (record: DatasetRecord): boolean =>
  meta(record)?.dataset_reset === true;

/** `target` with `patch`'s scores (per name) and expected_output, if any. */
export const applyFacts = (
  target: DatasetRecord,
  patch: DatasetRecord,
): DatasetRecord => {
  const next = { ...target };
  if (patch.scores && Object.keys(patch.scores).length > 0) {
    next.scores = { ...(target.scores ?? {}), ...patch.scores };
  }
  if (patch.expected_output !== undefined && patch.expected_output !== null) {
    next.expected_output = patch.expected_output;
  }

  return next;
};

export const mergeRecords = (
  records: Iterable<DatasetRecord>,
): DatasetRecord[] => {
  let out: DatasetRecord[] = [];
  let position = new Map<string, number>();
  let pending = new Map<string, DatasetRecord>();

  for (const record of records) {
    if (isReset(record)) {
      out = [];
      position = new Map();
      pending = new Map();
      continue;
    }

    const id = record.id;
    if (!id) {
      out.push(record);
      continue;
    }

    const at = position.get(id);
    if (isScoreUpdate(record)) {
      if (at === undefined) {
        pending.set(id, applyFacts(pending.get(id) ?? {}, record));
      } else {
        out[at] = applyFacts(out[at] as DatasetRecord, record);
      }
      continue;
    }

    let next: DatasetRecord = { ...record };
    if (at !== undefined) {
      const old = out[at] as DatasetRecord;
      const scores = { ...(old.scores ?? {}), ...(record.scores ?? {}) };
      if (Object.keys(scores).length > 0) next.scores = scores;
      if (
        (next.expected_output === undefined || next.expected_output === null) &&
        old.expected_output !== undefined &&
        old.expected_output !== null
      ) {
        next.expected_output = old.expected_output;
      }
      out[at] = next;
    } else {
      position.set(id, out.length);
      out.push(next);
    }

    const early = pending.get(id);
    if (early) {
      next = applyFacts(next, early);
      out[position.get(id) as number] = next;
      pending.delete(id);
    }
  }

  return out.filter(passesScoreFilter).map(admitted);
};

/** `grad_trainer/records.py::passes_score_filter`. */
export const passesScoreFilter = (record: DatasetRecord): boolean => {
  const rule = meta(record)?.[SCORE_FILTER] as
    | { has_feedback?: unknown; min_score?: unknown }
    | undefined;
  if (!rule || typeof rule !== "object") return true;
  const named = record.scores ?? {};
  const scores = Object.values(named);
  if (
    rule.has_feedback === true &&
    scores.length === 0 &&
    (record.expected_output === undefined || record.expected_output === null)
  ) {
    return false;
  }
  const min = rule.min_score;
  if (typeof min === "number") {
    return scores.length > 0 && scores.every((v) => v >= min);
  }
  if (min && typeof min === "object") {
    return Object.entries(min as Record<string, number>).every(
      ([name, floor]) =>
        typeof named[name] === "number" && named[name] >= floor,
    );
  }

  return true;
};

const admitted = (record: DatasetRecord): DatasetRecord => {
  const m = meta(record);
  if (!m || !(SCORE_FILTER in m)) return record;
  const { [SCORE_FILTER]: _rule, ...rest } = m;

  return { ...record, metadata: rest };
};

/** A score-update record for `id` (appended by `dataset.score()`). */
export const scoreUpdate = (
  id: string,
  scores: Record<string, number>,
): DatasetRecord => ({ id, scores, metadata: { [SCORE_UPDATE]: true } });
