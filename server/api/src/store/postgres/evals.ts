import type { Clock } from "../../clock.js";
import type { DatasetRecord } from "../../contracts.js";
import { newId } from "../../ids.js";
import { decodeCursor, toPage } from "../cursor.js";
import type { EvalRepository } from "../types.js";
import {
  expectClause,
  Params,
  setClause,
  type ColumnTypes,
  type Db,
} from "./db.js";
import { toEval, toEvalOutput, toEvalResult, toEvalTask } from "./mappers.js";
import { addSecondsIso, first, listNewest, nowIso } from "./shared.js";

const EVAL_COLUMNS: ColumnTypes = {
  json: new Set(["summary"]),
  timestamps: new Set(["lease_expires_at", "updated_at", "completed_at"]),
};

const withRecord = <T>(row: T, raw: Record<string, unknown>) => ({
  ...row,
  record: (raw.task_record ?? {}) as DatasetRecord,
});

export const createEvalRepository = (db: Db, clock: Clock): EvalRepository => ({
  create: async (input) => {
    const ts = nowIso(clock);
    const rows = await db.query(
      `INSERT INTO grad_evals
         (id, workspace_id, name, status, models, model_targets, baseline, dataset_id,
          dataset_name, dataset_version, rubric, samples, temperature, max_tokens, "limit",
          pass_threshold, judge_models, local_scorers, created_at, updated_at)
       VALUES ($1, $2, $3, 'queued', $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11,
               $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18::timestamptz, $18::timestamptz)
       RETURNING *`,
      [
        newId("eval"),
        input.workspace_id,
        input.name,
        JSON.stringify(input.models),
        JSON.stringify(input.model_targets),
        input.baseline,
        input.dataset_id,
        input.dataset_name,
        input.dataset_version,
        JSON.stringify(input.rubric),
        input.samples,
        input.temperature,
        input.max_tokens,
        input.limit,
        input.pass_threshold,
        JSON.stringify(input.judge_models),
        JSON.stringify(input.local_scorers),
        ts,
      ],
    );

    return toEval(rows[0] ?? {});
  },
  get: async (workspaceId, id) => {
    const row = first(
      await db.query(
        "SELECT * FROM grad_evals WHERE workspace_id = $1 AND id = $2",
        [workspaceId, id],
      ),
    );

    return row ? toEval(row) : null;
  },
  getById: async (id) => {
    const row = first(
      await db.query("SELECT * FROM grad_evals WHERE id = $1", [id]),
    );

    return row ? toEval(row) : null;
  },
  list: (workspaceId, page) => {
    const params = new Params();

    return listNewest(db, {
      table: "grad_evals",
      where: `workspace_id = ${params.add(workspaceId)}`,
      params,
      page,
      map: toEval,
    });
  },
  update: async (id, patch, expect) => {
    const params = new Params();
    const sets = setClause(
      { ...patch, updated_at: patch.updated_at ?? nowIso(clock) },
      EVAL_COLUMNS,
      params,
    );
    const where = `id = ${params.add(id)}${expectClause(expect, params)}`;
    const row = first(
      await db.query(
        `UPDATE grad_evals SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
        params.values,
      ),
    );

    return row ? toEval(row) : null;
  },
  claimNext: async ({ workerId, leaseSeconds, now, workspaceId }) => {
    const row = first(
      await db.query(
        `UPDATE grad_evals
         SET status = 'running', attempt = attempt + 1, worker_id = $1,
             lease_expires_at = $2::timestamptz, lease_seconds = $3,
             updated_at = $4::timestamptz
         WHERE id = (
           SELECT id FROM grad_evals
           WHERE status = 'queued' AND ($5::text IS NULL OR workspace_id = $5)
           ORDER BY created_at, id COLLATE "C"
           LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [
          workerId,
          addSecondsIso(now, leaseSeconds),
          leaseSeconds,
          now.toISOString(),
          workspaceId ?? null,
        ],
      ),
    );

    return row ? toEval(row) : null;
  },
  listExpiredLeases: async (now, limit) =>
    (
      await db.query(
        `SELECT * FROM grad_evals
         WHERE worker_id IS NOT NULL
           AND lease_expires_at + make_interval(secs => lease_seconds / 3.0) < $1::timestamptz
         ORDER BY lease_expires_at LIMIT $2`,
        [now.toISOString(), limit],
      )
    ).map(toEval),

  listAwaitingScores: async (limit) =>
    (
      await db.query(
        `SELECT * FROM grad_evals WHERE status = 'awaiting_scores'
         ORDER BY updated_at LIMIT $1`,
        [limit],
      )
    ).map(toEval),

  insertTasks: async (evalId, tasks) => {
    if (tasks.length === 0) return;
    await db.query(
      `INSERT INTO grad_eval_tasks (eval_id, task_index, task_id, record)
       SELECT $1, x.task_index, x.task_id, x.record
       FROM jsonb_to_recordset($2::jsonb) AS x(task_index int, task_id text, record jsonb)
       ON CONFLICT (eval_id, task_index) DO NOTHING`,
      [
        evalId,
        JSON.stringify(
          tasks.map((t) => ({
            task_index: t.task_index,
            task_id: t.task_id,
            record: t.record,
          })),
        ),
      ],
    );
  },
  listTasks: async (evalId, afterIndex, limit) =>
    (
      await db.query(
        `SELECT * FROM grad_eval_tasks WHERE eval_id = $1 AND task_index > $2
         ORDER BY task_index LIMIT $3`,
        [evalId, afterIndex, limit],
      )
    ).map(toEvalTask),

  upsertOutput: async (o) => {
    await db.query(
      `INSERT INTO grad_eval_outputs
         (id, eval_id, task_index, task_id, model, sample_index, input, output, expected_output,
          scores, error, prompt_tokens, completion_tokens, cost_usd, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14,
               $15::timestamptz)
       ON CONFLICT (eval_id, model, task_index, sample_index) DO NOTHING`,
      [
        o.id,
        o.eval_id,
        o.task_index,
        o.task_id,
        o.model,
        o.sample_index,
        JSON.stringify(o.input),
        o.output,
        JSON.stringify(o.expected_output ?? null),
        JSON.stringify(o.scores),
        o.error,
        o.prompt_tokens,
        o.completion_tokens,
        o.cost_usd,
        o.created_at,
      ],
    );
  },
  listOutputKeys: async (evalId) =>
    new Set(
      (
        await db.query(
          "SELECT model, task_index, sample_index FROM grad_eval_outputs WHERE eval_id = $1",
          [evalId],
        )
      ).map(
        (r) =>
          `${String(r.model)}\u0000${Number(r.task_index)}\u0000${Number(r.sample_index)}`,
      ),
    ),
  listOutputs: async (evalId, filter, page) => {
    const params = new Params();
    let where = `o.eval_id = ${params.add(evalId)}`;
    if (filter.model) where += ` AND o.model = ${params.add(filter.model)}`;
    if (filter.missingScorer) {
      where += ` AND o.error IS NULL AND NOT (o.scores ? ${params.add(filter.missingScorer)})`;
    }
    const after = decodeCursor(page.cursor, 3);
    if (after) {
      where += ` AND (o.task_index, o.model COLLATE "C", o.sample_index) > (${params.add(Number(after[0]))}::int, ${params.add(String(after[1]))}::text, ${params.add(Number(after[2]))}::int)`;
    }
    const rows = await db.query(
      `SELECT o.*, t.record AS task_record FROM grad_eval_outputs o
       LEFT JOIN grad_eval_tasks t ON t.eval_id = o.eval_id AND t.task_index = o.task_index
       WHERE ${where}
       ORDER BY o.task_index, o.model COLLATE "C", o.sample_index
       LIMIT ${params.add(page.limit + 1)}`,
      params.values,
    );

    return toPage(
      rows.map((r) => withRecord(toEvalOutput(r), r)),
      page.limit,
      (o) => [o.task_index, o.model, o.sample_index],
    );
  },
  setScores: async (evalId, entries) => {
    if (entries.length === 0) return 0;
    const ids = [...new Set(entries.map((e) => e.output_id))];
    const known = new Set(
      (
        await db.query(
          "SELECT id FROM grad_eval_outputs WHERE eval_id = $1 AND id = ANY($2::text[])",
          [evalId, ids],
        )
      ).map((r) => String(r.id)),
    );
    const merged = new Map<string, Record<string, number>>();
    let accepted = 0;
    for (const entry of entries) {
      if (!known.has(entry.output_id)) continue;
      const scores = merged.get(entry.output_id) ?? {};
      scores[entry.scorer] = entry.score;
      merged.set(entry.output_id, scores);
      accepted += 1;
    }
    if (merged.size > 0) {
      await db.query(
        `UPDATE grad_eval_outputs o SET scores = o.scores || x.scores
         FROM jsonb_to_recordset($2::jsonb) AS x(id text, scores jsonb)
         WHERE o.eval_id = $1 AND o.id = x.id`,
        [
          evalId,
          JSON.stringify(
            [...merged.entries()].map(([id, scores]) => ({ id, scores })),
          ),
        ],
      );
    }

    return accepted;
  },
  countMissingScores: async (evalId, scorers) => {
    if (scorers.length === 0) return 0;
    const row = first(
      await db.query(
        `SELECT COUNT(*) AS count FROM grad_eval_outputs
         WHERE eval_id = $1 AND error IS NULL AND NOT (scores ?& $2::text[])`,
        [evalId, [...scorers]],
      ),
    );

    return Number(row?.count ?? 0);
  },
  replaceResults: (evalId, rows) =>
    db.atomic(async () => {
      await db.query("DELETE FROM grad_eval_results WHERE eval_id = $1", [
        evalId,
      ]);
      if (rows.length === 0) return;
      await db.query(
        `INSERT INTO grad_eval_results
           (eval_id, task_index, task_id, model, score, passed, sample_scores, judge_model)
         SELECT $1, x.task_index, x.task_id, x.model, x.score, x.passed, x.sample_scores,
                x.judge_model
         FROM jsonb_to_recordset($2::jsonb) AS x(
           task_index int, task_id text, model text, score double precision, passed boolean,
           sample_scores jsonb, judge_model text)`,
        [
          evalId,
          JSON.stringify(
            rows.map((r) => ({
              task_index: r.task_index,
              task_id: r.task_id,
              model: r.model,
              score: r.score,
              passed: r.passed,
              sample_scores: r.sample_scores,
              judge_model: r.judge_model,
            })),
          ),
        ],
      );
    }),
  listResults: async (evalId, filter, page) => {
    const params = new Params();
    let where = `r.eval_id = ${params.add(evalId)}`;
    if (filter.model) where += ` AND r.model = ${params.add(filter.model)}`;
    if (filter.maxScore !== undefined) {
      where += ` AND r.score < ${params.add(filter.maxScore)}`;
    }
    const after = decodeCursor(page.cursor, 2);
    if (after) {
      where += ` AND (r.task_index, r.model COLLATE "C") > (${params.add(Number(after[0]))}::int, ${params.add(String(after[1]))}::text)`;
    }
    const rows = await db.query(
      `SELECT r.*, t.record AS task_record FROM grad_eval_results r
       LEFT JOIN grad_eval_tasks t ON t.eval_id = r.eval_id AND t.task_index = r.task_index
       WHERE ${where}
       ORDER BY r.task_index, r.model COLLATE "C"
       LIMIT ${params.add(page.limit + 1)}`,
      params.values,
    );

    return toPage(
      rows.map((r) => withRecord(toEvalResult(r), r)),
      page.limit,
      (r) => [r.task_index, r.model],
    );
  },
});
