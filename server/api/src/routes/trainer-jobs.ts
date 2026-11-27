import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  CheckpointSchema,
  ClaimJobRequestSchema,
  ClaimJobResponseSchema,
  CompleteJobRequestSchema,
  CompleteJobResponseSchema,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  PostImportRecordsRequestSchema,
  PostImportRecordsResponseSchema,
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

const isImportJob = (id: string): boolean => id.startsWith("imp_");

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
      summary: "Claim the next queued train or import job (trainer:worker)",
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
      // One queue, oldest first across the requested kinds.
      const job = await services.queue.claim(principal, {
        workerId: input.worker_id,
        leaseSeconds: input.lease_seconds,
        kinds,
        recipes: input.recipes,
        gpu: input.gpu,
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
      if (isImportJob(id))
        throw conflict("wrong_job_kind", "Import jobs do not report events.");
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
      if (isImportJob(id))
        throw conflict("wrong_job_kind", "Import jobs do not report progress.");

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
      summary: "Get an upload URL for a checkpoint or artifact bundle",
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
      if (isImportJob(id))
        throw conflict("wrong_job_kind", "Import jobs do not upload bundles.");
      const ticket = await services.runs.createUpload(
        principal,
        id,
        c.req.valid("json"),
      );

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
      if (isImportJob(id))
        throw conflict("wrong_job_kind", "Import jobs have no checkpoints.");
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
      path: "/v1/trainer-jobs/{id}/records",
      operationId: "postImportRecords",
      summary: "Append a batch of parsed records to an import job",
      tags,
      "x-internal": true,
      request: {
        params: IdParamSchema,
        ...body(PostImportRecordsRequestSchema),
      },
      responses: {
        200: jsonResponse(
          PostImportRecordsResponseSchema,
          "Accepted and rejected counts.",
        ),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const { id } = c.req.valid("param");
      if (!isImportJob(id))
        throw conflict("wrong_job_kind", "Only import jobs accept records.");

      return c.json(
        await services.imports.postRecords(principal, id, c.req.valid("json")),
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

      if (isImportJob(id)) {
        const job = await services.imports.complete(principal, id, input);

        return c.json(
          {
            job_id: id,
            kind: "import" as const,
            status: job.status,
            run: null,
            artifact: null,
            import: job,
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
        "Stream the pinned dataset version of a claimed train job as gzip-compressed JSONL",
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
      const stream = await services.runs.datasetStream(
        principal,
        id,
        c.req.valid("query").attempt,
      );

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/gzip" },
      }) as never;
    },
  );
};
