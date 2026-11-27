import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  CheckpointSchema,
  ClaimJobRequestSchema,
  ClaimJobResponseSchema,
  CompleteJobRequestSchema,
  CompleteJobResponseSchema,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  PostEvalOutputsRequestSchema,
  PostEvalOutputsResponseSchema,
  RegisterImportPartRequestSchema,
  RegisterImportPartResponseSchema,
  RegisterCheckpointRequestSchema,
  ReportEventRequestSchema,
  ReportProgressRequestSchema,
  ReportProgressResponseSchema,
  TRAINER_PROTOCOL_VERSION,
  UploadTicketSchema,
  WorkerUploadRequestSchema,
} from "../contracts.js";
import { claimableKinds } from "../adapters.js";
import type { AppDependencies } from "../deps.js";
import { conflict, forbidden, notFound } from "../errors.js";
import type { Services } from "../services/index.js";
import {
  defaultErrors,
  IdParamSchema,
  jsonResponse,
  requireScope,
  type AppEnv,
} from "./helpers.js";
import { assertClaimAllowed } from "../worker-auth/principal.js";

const isImportJob = (id: string): boolean => id.startsWith("imp_");
const isEvalJob = (id: string): boolean => id.startsWith("eval_");

/** Train-only endpoints refuse import and eval jobs. */
const assertTrainJob = (id: string, what: string): void => {
  if (isImportJob(id) || isEvalJob(id)) {
    throw conflict(
      "wrong_job_kind",
      `${isImportJob(id) ? "Import" : "Eval"} jobs do not ${what}.`,
    );
  }
};

const body = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});

export const registerTrainerJobRoutes = (
  app: OpenAPIHono<AppEnv>,
  _deps: AppDependencies,
  services: Services,
): void => {
  const tags = ["TrainerJobs"];

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/trainer-jobs/claim",
      operationId: "claimTrainerJob",
      summary:
        "Claim the next queued train, import or eval job (trainer:worker)",
      tags,
      "x-internal": true,
      request: body(ClaimJobRequestSchema),
      responses: {
        200: jsonResponse(
          ClaimJobResponseSchema,
          "Claimed job, or null when idle.",
        ),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const input = c.req.valid("json");
      // The key decides what it may claim: import jobs carry workspace secrets.
      const kinds = claimableKinds(principal, input.kinds);
      if (kinds.length === 0) {
        throw forbidden(
          "job_kind_forbidden",
          `This trainer key may claim only ${(principal.workerKinds ?? []).join(", ")} jobs, not ${input.kinds.join(", ")}.`,
        );
      }
      // A lease token is bound to its host and bounds the GPU the worker reports.
      assertClaimAllowed(principal, input);
      // One queue, fair across workspaces, over the requested kinds.
      const job = await services.queue.claim(principal, {
        workerId: input.worker_id,
        leaseSeconds: input.lease_seconds,
        kinds,
        recipes: input.recipes,
        gpu: input.gpu,
        device: input.device,
      });

      return c.json(
        {
          protocol: TRAINER_PROTOCOL_VERSION as typeof TRAINER_PROTOCOL_VERSION,
          job,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/trainer-jobs/{id}/heartbeat",
      operationId: "heartbeatTrainerJob",
      summary: "Renew the job lease; reports whether the worker should stop",
      tags,
      "x-internal": true,
      request: { params: IdParamSchema, ...body(HeartbeatRequestSchema) },
      responses: {
        200: jsonResponse(HeartbeatResponseSchema, "Lease renewed."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const { id } = c.req.valid("param");
      const result = await services.queue.heartbeat(
        principal,
        id,
        c.req.valid("json"),
      );

      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/trainer-jobs/{id}/events",
      operationId: "reportTrainerEvent",
      summary: "Report a train job's phase, or a log or warning line",
      tags,
      "x-internal": true,
      request: { params: IdParamSchema, ...body(ReportEventRequestSchema) },
      responses: {
        204: { description: "Stored (a replay is stored once)." },
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const { id } = c.req.valid("param");
      assertTrainJob(id, "report events");
      await services.runs.reportEvent(principal, id, c.req.valid("json"));

      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/trainer-jobs/{id}/progress",
      operationId: "reportTrainerProgress",
      summary: "Report one training step's metrics",
      tags,
      "x-internal": true,
      request: { params: IdParamSchema, ...body(ReportProgressRequestSchema) },
      responses: {
        200: jsonResponse(
          ReportProgressResponseSchema,
          "Stop flag and server-side cost.",
        ),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const { id } = c.req.valid("param");
      assertTrainJob(id, "report progress");

      return c.json(
        await services.runs.progress(principal, id, c.req.valid("json")),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/trainer-jobs/{id}/uploads",
      operationId: "createTrainerUpload",
      summary:
        "Get an upload URL for a checkpoint or artifact bundle, or an import's dataset part",
      tags,
      "x-internal": true,
      request: { params: IdParamSchema, ...body(WorkerUploadRequestSchema) },
      responses: {
        201: jsonResponse(UploadTicketSchema, "Upload ticket."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      if (isEvalJob(id)) {
        throw conflict("wrong_job_kind", "Eval jobs upload nothing.");
      }
      const allowed = isImportJob(id)
        ? input.kind !== "checkpoint"
        : input.kind !== "records";
      if (!allowed) {
        throw conflict(
          "wrong_job_kind",
          "Train jobs upload checkpoints and artifacts; import jobs upload records parts (dataset imports) or their artifact bundle (artifact imports).",
        );
      }
      const ticket = isImportJob(id)
        ? await services.imports.createUpload(principal, id, input)
        : await services.runs.createUpload(principal, id, input);

      return c.json(ticket, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/trainer-jobs/{id}/checkpoints",
      operationId: "registerTrainerCheckpoint",
      summary: "Register an uploaded checkpoint bundle",
      tags,
      "x-internal": true,
      request: {
        params: IdParamSchema,
        ...body(RegisterCheckpointRequestSchema),
      },
      responses: {
        200: jsonResponse(CheckpointSchema, "Existing identical checkpoint."),
        201: jsonResponse(CheckpointSchema, "Registered checkpoint."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const { id } = c.req.valid("param");
      assertTrainJob(id, "have checkpoints");
      const { checkpoint, created } = await services.runs.registerCheckpoint(
        principal,
        id,
        c.req.valid("json"),
      );

      return created ? c.json(checkpoint, 201) : c.json(checkpoint, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/trainer-jobs/{id}/parts",
      operationId: "registerImportPart",
      summary:
        "Stage an uploaded dataset part of an import job (the worker uploads it directly to storage)",
      tags,
      "x-internal": true,
      request: {
        params: IdParamSchema,
        ...body(RegisterImportPartRequestSchema),
      },
      responses: {
        200: jsonResponse(RegisterImportPartResponseSchema, "Staged."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const { id } = c.req.valid("param");
      if (!isImportJob(id))
        throw conflict("wrong_job_kind", "Only import jobs stage parts.");

      return c.json(
        await services.imports.registerPart(principal, id, c.req.valid("json")),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/trainer-jobs/{id}/outputs",
      operationId: "postTrainerEvalOutputs",
      summary:
        "Store a batch of an eval job's generated and scored outputs (priced and billed by the server)",
      tags,
      "x-internal": true,
      request: {
        params: IdParamSchema,
        ...body(PostEvalOutputsRequestSchema),
      },
      responses: {
        200: jsonResponse(PostEvalOutputsResponseSchema, "Stored."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const { id } = c.req.valid("param");
      if (!isEvalJob(id))
        throw conflict("wrong_job_kind", "Only eval jobs post outputs.");

      return c.json(
        await services.evals.postOutputs(principal, id, c.req.valid("json")),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/trainer-jobs/{id}/complete",
      operationId: "completeTrainerJob",
      summary:
        "Finish a job attempt: publish its artifact, bill it, release the lease",
      tags,
      "x-internal": true,
      request: { params: IdParamSchema, ...body(CompleteJobRequestSchema) },
      responses: {
        200: jsonResponse(CompleteJobResponseSchema, "Final job state."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");

      if (isEvalJob(id)) {
        const ev = await services.evals.complete(principal, id, input);

        return c.json(
          {
            job_id: id,
            kind: "eval" as const,
            status: ev.status,
            run: null,
            artifact: null,
            import: null,
            eval: ev,
          },
          200,
        );
      }

      if (isImportJob(id)) {
        const done = await services.imports.complete(principal, id, input);

        return c.json(
          {
            job_id: id,
            kind: "import" as const,
            status: (done.import ?? done.artifactImport).status,
            run: null,
            artifact: done.artifact,
            import: done.import,
            artifact_import: done.artifactImport,
          },
          200,
        );
      }

      const { run, artifact } = await services.runs.complete(
        principal,
        id,
        input,
      );

      return c.json(
        {
          job_id: id,
          kind: "train" as const,
          status: run.status,
          run,
          artifact,
          import: null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/trainer-jobs/{id}/dataset",
      operationId: "downloadTrainerDataset",
      summary:
        "Stream the pinned dataset version of a claimed train or eval job as gzip-compressed JSONL",
      tags,
      "x-internal": true,
      request: {
        params: IdParamSchema,
        query: z.object({ attempt: z.coerce.number().int().min(1) }),
      },
      responses: {
        200: {
          description:
            "Dataset records as gzip-compressed JSON Lines (the stored parts, concatenated; gunzip yields the records in order, before merging).",
          content: { "application/gzip": { schema: z.string() } },
        },
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const { id } = c.req.valid("param");
      if (isImportJob(id)) throw notFound("trainer_job", id);
      const { attempt } = c.req.valid("query");
      const stream = isEvalJob(id)
        ? await services.evals.datasetStream(principal, id, attempt)
        : await services.runs.datasetStream(principal, id, attempt);

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/gzip" },
      }) as never;
    },
  );
};
