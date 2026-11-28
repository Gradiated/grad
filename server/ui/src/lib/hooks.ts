import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export interface ResourceOptions<T> {
  /** Re-fetch this often while the tab is visible; a function decides from the latest data. */
  pollMs?: number | ((data: T | undefined) => number | undefined) | undefined;
}

/** Fetches on mount and when `deps` change; optionally polls while the tab is visible. */
export const useResource = <T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[], options: ResourceOptions<T> = {}): Resource<T> => {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const pollRef = useRef(options.pollMs);
  pollRef.current = options.pollMs;
  const depsKey = JSON.stringify(deps);
  const lastKey = useRef(depsKey);

  useEffect(() => {
    if (lastKey.current !== depsKey) {
      lastKey.current = depsKey;
      setData(undefined);
    }
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: T | undefined;
    const run = async () => {
      setLoading(true);
      try {
        latest = await fetchRef.current(ctrl.signal);
        if (ctrl.signal.aborted) return;
        setData(latest);
        setError(null);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
      schedule();
    };
    const schedule = () => {
      const p = pollRef.current;
      const ms = typeof p === "function" ? p(latest) : p;
      if (!ms || ctrl.signal.aborted) return;
      timer = setTimeout(() => {
        if (document.visibilityState === "hidden") schedule();
        else void run();
      }, ms);
    };
    void run();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
};

export interface Paged<T> {
  data: T[];
  nextCursor: string | null;
}

export interface PagedList<T> {
  items: T[];
  /** The first page is loading for the first time. */
  loading: boolean;
  error: unknown;
  reload: () => void;
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
  moreError: unknown;
}

/**
 * A cursor-paginated list: the first page is fetched (and polled) like
 * `useResource`; `loadMore` appends older pages, which reset when `deps` change.
 * Items are de-duplicated by `id` so a poll that shifts the first page never
 * shows one twice.
 */
export const usePagedList = <T extends { id?: string | null | undefined }>(
  page: (cursor: string | undefined, signal: AbortSignal | undefined) => Promise<Paged<T>>,
  deps: unknown[],
  options: ResourceOptions<Paged<T>> = {},
): PagedList<T> => {
  const first = useResource((signal) => page(undefined, signal), deps, options);
  const key = JSON.stringify(deps);
  const [older, setOlder] = useState<{ key: string; items: T[]; cursor: string | null } | null>(null);
  const [more, setMore] = useState<{ busy: boolean; error: unknown }>({ busy: false, error: null });
  const extra = older?.key === key ? older : null;
  const cursor = extra ? extra.cursor : (first.data?.nextCursor ?? null);
  const pageRef = useRef(page);
  pageRef.current = page;

  const items = useMemo(() => {
    const head = first.data?.data ?? [];
    if (!extra) return head;
    const seen = new Set(head.map((t) => t.id).filter(Boolean));
    return [...head, ...extra.items.filter((t) => !t.id || !seen.has(t.id))];
  }, [first.data, extra]);

  const loadMore = useCallback(() => {
    if (!cursor || more.busy) return;
    setMore({ busy: true, error: null });
    pageRef.current(cursor, undefined).then(
      (p) => {
        setOlder((o) => ({ key, items: [...(o?.key === key ? o.items : []), ...p.data], cursor: p.nextCursor }));
        setMore({ busy: false, error: null });
      },
      (error: unknown) => setMore({ busy: false, error }),
    );
  }, [cursor, key, more.busy]);

  return {
    items,
    loading: first.loading && !first.data,
    error: first.error,
    reload: first.reload,
    hasMore: cursor !== null,
    loadMore,
    loadingMore: more.busy,
    moreError: more.error,
  };
};

/** `value`, once it has stopped changing for `ms` (typing in a search box). */
export const useDebounced = <T>(value: T, ms = 250): T => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
};

/** Re-renders every `ms` so relative times stay fresh. */
export const useNow = (ms = 15_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
};
