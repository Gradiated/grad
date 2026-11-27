import { useCallback, useEffect, useRef, useState } from "react";

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

/** Tracks prefers-color-scheme so charts can re-theme. */
export const useColorScheme = (): "light" | "dark" => {
  const [query] = useState(() => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined));
  const [dark, setDark] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, [query]);
  return dark ? "dark" : "light";
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
