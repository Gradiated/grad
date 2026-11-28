import { useEffect, useState } from "react";

import { encodePathParam } from "@sdk/transport.js";

import { APIError, type Api } from "./api.js";
import { applyEvents, decodeEvent, emptyStream, type RunEvent, type RunStreamState } from "./events.js";

export interface StreamDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Flushes buffered events to React this often (ms). */
  flushMs?: number;
  /** Called with true when the stream (re)connects and false when it drops. */
  onConnected?: (connected: boolean) => void;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Follows a run's event stream until its final event, resuming with
 * Last-Event-ID after a dropped connection. Falls back to the metrics stream
 * on servers without `/events`. Calls `onBatch` with decoded events.
 */
export const followRun = async (
  api: Api,
  runId: string,
  onBatch: (events: RunEvent[]) => void,
  signal: AbortSignal,
  deps: StreamDeps = {},
): Promise<void> => {
  const sleep = deps.sleep ?? wait;
  const flushMs = deps.flushMs ?? 200;
  let path = `/v1/runs/${encodePathParam(runId, "id")}/events`;
  let lastEventId: string | undefined;
  let failures = 0;
  let buffer: RunEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connected = false;
  const setConnected = (c: boolean) => {
    if (c === connected) return;
    connected = c;
    deps.onConnected?.(c);
  };
  const flush = () => {
    timer = undefined;
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    onBatch(batch);
  };

  try {
    while (!signal.aborted) {
      try {
        for await (const message of api.transport.sse({ method: "GET", path }, { signal, lastEventId, idleTimeoutMs: 90_000 })) {
          failures = 0;
          setConnected(true);
          if (message.id !== undefined) lastEventId = message.id;
          const ev = decodeEvent(message.event, message.data);
          if (!ev) continue;
          buffer.push(ev);
          if (ev.type === "completed") {
            flush();
            return;
          }
          timer ??= setTimeout(flush, flushMs);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof APIError && error.status === 404 && error.code === "route_not_found" && path.endsWith("/events")) {
          path = path.replace(/\/events$/, "/metrics");
          continue;
        }
        if (error instanceof APIError && error.status < 500 && error.status !== 429) throw error;
      }
      flush();
      setConnected(false);
      failures += 1;
      await sleep(Math.min(15_000, 500 * 2 ** Math.min(failures, 5)));
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (!signal.aborted) flush();
  }
};

/** React state for one run's event stream; `connected` is false until the first event and while reconnecting. */
export const useRunStream = (api: Api, runId: string): { state: RunStreamState; error: unknown; connected: boolean } => {
  const [state, setState] = useState<RunStreamState>(emptyStream);
  const [error, setError] = useState<unknown>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    setState(emptyStream());
    setError(null);
    setConnected(false);
    followRun(api, runId, (batch) => setState((s) => applyEvents(s, batch)), ctrl.signal, { onConnected: setConnected }).catch((e: unknown) => {
      if (!ctrl.signal.aborted) setError(e);
    });
    return () => ctrl.abort();
  }, [api, runId]);
  return { state, error, connected };
};
