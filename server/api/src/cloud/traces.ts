import { z } from "zod";

import type { TracesAdapter } from "../adapters.js";
import { ApiError, errorMessage } from "../errors.js";
import {
  cloudRequest,
  cloudUrl,
  detailOf,
  isOk,
  type CloudResponse,
} from "./http.js";

const TracesPageSchema = z.object({
  records: z.array(z.record(z.string(), z.unknown())),
  cursor: z.string().max(4096).nullable(),
  has_more: z.boolean(),
});

/**
 * The `gradiated` source: gateway traces and feedback for one workspace, from
 * the product's internal `training/traces:pull` (the token stays here; workers
 * reach it only through their job's `/source-page`).
 */
export const createCloudTracesAdapter = (options: {
  internalApiBaseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): TracesAdapter => {
  const url = `${cloudUrl("CLOUD_INTERNAL_API_URL", options.internalApiBaseUrl)}/api/internal/v1/training/traces:pull`;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  return {
    pull: async ({ workspaceId, filter, cursor, limit }) => {
      let res: CloudResponse;
      try {
        res = await cloudRequest(fetchFn, url, {
          token: options.serviceToken,
          body: { workspace_id: workspaceId, filter, cursor, limit },
          timeoutMs: options.timeoutMs ?? 15_000,
        });
      } catch (error) {
        throw new ApiError(
          503,
          "source_upstream_unavailable",
          "Gradiated Cloud traces unavailable",
          errorMessage(error),
        );
      }
      if (!isOk(res.status)) {
        throw new ApiError(
          502,
          "source_upstream_error",
          "Gradiated Cloud traces failed",
          `Gradiated Cloud traces:pull returned HTTP ${res.status}${detailOf(res)}.`,
        );
      }
      const page = TracesPageSchema.safeParse(res.json);
      if (!page.success) {
        throw new ApiError(
          502,
          "source_upstream_error",
          "Gradiated Cloud traces failed",
          "Gradiated Cloud traces:pull returned an unexpected body.",
        );
      }

      return page.data;
    },
  };
};
