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
 * - records without an id pass through unchanged.
 */
export const SCORE_UPDATE = "score_update";

const meta = (record: DatasetRecord): Record<string, unknown> | undefined =>
  record.metadata;

export const isScoreUpdate = (record: DatasetRecord): boolean =>
  meta(record)?.[SCORE_UPDATE] === true;

export const isReset = (record: DatasetRecord): boolean =>
  meta(record)?.dataset_reset === true;

const apply = (target: DatasetRecord, patch: DatasetRecord): DatasetRecord => {
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
        pending.set(id, apply(pending.get(id) ?? {}, record));
      } else {
        out[at] = apply(out[at] as DatasetRecord, record);
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
      next = apply(next, early);
      out[position.get(id) as number] = next;
      pending.delete(id);
    }
  }

  return out;
};

/** A score-update record for `id` (appended by `dataset.score()`). */
export const scoreUpdate = (
  id: string,
  scores: Record<string, number>,
): DatasetRecord => ({ id, scores, metadata: { [SCORE_UPDATE]: true } });
