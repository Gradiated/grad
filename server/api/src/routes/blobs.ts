import { Readable } from "node:stream";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { AppDependencies } from "../deps.js";
import { ApiError, notFound } from "../errors.js";
import type { Services } from "../services/index.js";
import { BLOB_DOWNLOAD_PATH, BLOB_UPLOAD_PREFIX } from "../storage/signer.js";
import { ObjectNotFoundError } from "../storage/types.js";
import type { AppEnv } from "./helpers.js";

const emptyBody = async function* (): AsyncGenerator<Uint8Array> {};

/**
 * Server-proxied, HMAC-signed blob endpoints standing in for presigned S3 URLs
 * when the object store is the local filesystem. They sit outside `/v1` (no
 * bearer auth, no JSON body limit): the signature authorizes the request.
 * They are deliberately not part of the OpenAPI contract.
 */
export const registerBlobRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
  services: Services,
): void => {
  app.put(`${BLOB_UPLOAD_PREFIX}:id`, async (c) => {
    const id = c.req.param("id");
    const body = c.req.raw.body
      ? (Readable.fromWeb(c.req.raw.body as never) as AsyncIterable<Uint8Array>)
      : emptyBody();
    const upload = await services.uploads.receive(
      id,
      c.req.query("exp") ?? "",
      c.req.query("sig") ?? "",
      body,
    );

    return c.json(
      {
        upload_id: upload.id,
        sha256: upload.sha256,
        size_bytes: upload.size_bytes,
      },
      200,
    );
  });

  app.get(BLOB_DOWNLOAD_PATH, async (c) => {
    const key = c.req.query("key") ?? "";
    if (
      !deps.signer.verifyDownload(
        key,
        c.req.query("exp") ?? "",
        c.req.query("sig") ?? "",
        deps.clock.now(),
      )
    ) {
      throw new ApiError(
        403,
        "invalid_download_signature",
        "Invalid download URL",
        "The download URL signature is invalid or expired.",
      );
    }

    try {
      const stream = await deps.storage.getStream(key);

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw notFound("object", key);
      throw error;
    }
  });
};
