import type { ApiClient } from "./generated/client.js";
import type { RawResponse, RequestOptions, TransportLike } from "./transport.js";
import type { PollContext } from "./polling.js";

/** What every resource needs: the typed API, polling clock, and raw uploads. */
export interface Core {
  api: ApiClient;
  transport: TransportLike;
  poll: PollContext;
  /** PUTs a file to an upload ticket URL (relative URLs resolve against the API), streamed from disk. Never sends the API key. */
  upload: (url: string, headers: Record<string, string>, file: { path: string; sizeBytes: number }, options?: RequestOptions) => Promise<RawResponse>;
  baseURL: () => Promise<string>;
}

export const isNodeRuntime = (): boolean =>
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";
