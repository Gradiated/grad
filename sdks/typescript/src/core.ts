import type { ApiClient } from "./generated/client.js";
import type { RawResponse, RequestOptions, TransportLike } from "./generated/transport.js";
import type { PollContext } from "./polling.js";

/** What every resource needs: the typed API, polling clock, and raw uploads. */
export interface Core {
  api: ApiClient;
  transport: TransportLike;
  poll: PollContext;
  /** PUTs a replayable body to an upload ticket URL (relative URLs resolve against the API). Never sends the API key. */
  upload: (url: string, headers: Record<string, string>, body: Blob | Uint8Array | string, options?: RequestOptions) => Promise<RawResponse>;
  baseURL: () => Promise<string>;
}

export const isNodeRuntime = (): boolean =>
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";
