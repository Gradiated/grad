import type { Clock } from "../../clock.js";
import { decodeCursor, toPage } from "../cursor.js";
import type { EvalRecord, EvalRepository, EvalResultRow } from "../types.js";
import { Params, type Db, type Row } from "./db.js";
import { createJobBackedRepository } from "./jobs.js";
import { toEvalDomain, toEvalOutput, toJob } from "./mappers.js";
import { first } from "./shared.js";

const toResult = (r: Row): EvalResultRow => ({
  task_index: Number(r.task_index),
  task_id: String(r.task_id),
  model: String(r.model),
  score: Number(r.score),
  passed: r.passed === true,
  sample_scores: (r.sample_scores as unknown[]).map(Number),
  record: (r.record ?? {}) as EvalResultRow["record"],
});

export const createEvalRepository = (db: Db, clock: Clock): EvalRepository => {
  const repo = createJobBackedRepository<EvalRecord>(db, clock, {
    kind: "eval",
    table: "grad_evals",
    types: {
      json: new Set([
        "models",
        "model_targets",
        "rubric",
        "judge_models",
        "judge_targets",
        "local_scorers",
        "summary",
      ]),
      timestamps: new Set(),
    },
    map: (row) => ({ ...toJob(row), ...toEvalDomain(row) }),
  });

  return {
    get: repo.get,
    getById: repo.getById,
    list: repo.list,
    update: repo.update,
    create: ({
      workspaceId,
      maxAttempts,
      maxQueued,
      waitingOn,
      idempotency,
      totalOutputs,
      ...domain
    }) =>
      repo.insert(
        {
          prefix: "eval",
          kind: "eval",
          workspaceId,
          maxAttempts,
          maxQueued,
          waitingOn,
          idempotency,
        },
        { ...domain, total_outputs: totalOutputs },
      ),
    listAwaitingScores: async (limit) =>
      (
        await db.query(
          `SELECT * FROM grad_jobs JOIN grad_evals USING (id)
           WHERE kind = 'eval' AND status = 'awaiting_scores'
           ORDER BY updated_at LIMIT $1`,
          [limit],
        )
      ).map((row) => ({
        ...toJob<EvalRecord["status"]>(row),
        ...toEvalDomain(row),
      })),

    insertOutput: async (o) => {
      await db.query(
        `INSERT INTO grad_eval_outputs
           (id, eval_id, attempt, task_index, task_id, model, sample_index, record, input, output,
            expected_output, scores, error, prompt_tokens, completion_tokens, cost_usd, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13,
                 $14, $15, $16, $17::timestamptz)
         ON CONFLICT (eval_id, model, task_index, sample_index) DO NOTHING`,
        [
          o.id,
          o.eval_id,
          o.attempt,
          o.task_index,
          o.task_id,
          o.model,
          o.sample_index,
          JSON.stringify(o.record),
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
      let where = `eval_id = ${params.add(evalId)}`;
      if (filter.model) where += ` AND model = ${params.add(filter.model)}`;
      if (filter.missingScorer) {
        where += ` AND error IS NULL AND NOT (scores ? ${params.add(filter.missingScorer)})`;
      }
      const after = decodeCursor(page.cursor, 3);
      if (after) {
        where += ` AND (task_index, model COLLATE "C", sample_index) > (${params.add(Number(after[0]))}::int, ${params.add(String(after[1]))}::text, ${params.add(Number(after[2]))}::int)`;
      }
      const rows = await db.query(
        `SELECT * FROM grad_eval_outputs WHERE ${where}
         ORDER BY task_index, model COLLATE "C", sample_index
         LIMIT ${params.add(page.limit + 1)}`,
        params.values,
      );

      return toPage(rows.map(toEvalOutput), page.limit, (o) => [
        o.task_index,
        o.model,
        o.sample_index,
      ]);
    },
    attemptUsage: async (evalId, attempt) => {
      const row = first(
        await db.query(
          `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM grad_eval_outputs WHERE eval_id = $1 AND attempt = $2`,
          [evalId, attempt],
        ),
      );

      return {
        tokens: Number(row?.tokens ?? 0),
        cost_usd: Number(row?.cost_usd ?? 0),
      };
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
    setCombinedScores: async (evalId, scores) => {
      if (scores.length === 0) return;
      await db.query(
        `UPDATE grad_eval_outputs o SET score = x.score
         FROM jsonb_to_recordset($2::jsonb) AS x(id text, score double precision)
         WHERE o.eval_id = $1 AND o.id = x.id`,
        [evalId, JSON.stringify(scores)],
      );
    },
    listResults: async (evalId, filter, page) => {
      const params = new Params();
      let where = `eval_id = ${params.add(evalId)}`;
      if (filter.model) where += ` AND model = ${params.add(filter.model)}`;
      const after = decodeCursor(page.cursor, 2);
      if (after) {
        where += ` AND (task_index, model COLLATE "C") > (${params.add(Number(after[0]))}::int, ${params.add(String(after[1]))}::text)`;
      }
      const threshold = params.add(filter.passThreshold);
      const having =
        filter.maxScore === undefined
          ? ""
          : `HAVING round(avg(COALESCE(score, 0))::numeric, 4) < ${params.add(filter.maxScore)}`;
      const rows = await db.query(
        `SELECT task_index, task_id, model,
                round(avg(COALESCE(score, 0))::numeric, 4)::float8 AS score,
                bool_or(COALESCE(score, 0) >= ${threshold}::float8) AS passed,
                array_agg(round(COALESCE(score, 0)::numeric, 4)::float8 ORDER BY sample_index) AS sample_scores,
                (array_agg(record ORDER BY sample_index))[1] AS record
         FROM grad_eval_outputs WHERE ${where}
         GROUP BY task_index, task_id, model ${having}
         ORDER BY task_index, model COLLATE "C"
         LIMIT ${params.add(page.limit + 1)}`,
        params.values,
      );

      return toPage(rows.map(toResult), page.limit, (r) => [
        r.task_index,
        r.model,
      ]);
    },
  };
};
