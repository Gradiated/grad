// The API key lives in sessionStorage only: it is gone when the tab closes,
// never reaches a cookie (so there is no CSRF surface) and never touches
// localStorage. `grad ui` hands the local profile's key over once as a
// `#key=` fragment, which never leaves the browser; we read it and clear it.

const STORAGE_KEY = "grad.api_key";

export interface KeyStore {
  get(): string | undefined;
  set(key: string): void;
  clear(): void;
}

const safeSession = (): Storage | undefined => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

export const sessionKeyStore = (storage: Storage | undefined = safeSession()): KeyStore => {
  let memory: string | undefined;
  return {
    get: () => {
      try {
        return storage?.getItem(STORAGE_KEY) ?? memory;
      } catch {
        return memory;
      }
    },
    set: (key) => {
      memory = key;
      try {
        storage?.setItem(STORAGE_KEY, key);
      } catch {
        // Private mode: keep it in memory for this page only.
      }
    },
    clear: () => {
      memory = undefined;
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch {
        // nothing stored
      }
    },
  };
};

/** Reads a one-time `#key=` fragment, stores the key and removes it from the URL. */
export const takeFragmentKey = (store: KeyStore, loc: Location = location, hist: History = history): boolean => {
  if (!loc.hash.startsWith("#")) return false;
  const params = new URLSearchParams(loc.hash.slice(1));
  const key = params.get("key")?.trim();
  if (!key) return false;
  store.set(key);
  params.delete("key");
  const rest = params.toString();
  hist.replaceState(hist.state, "", `${loc.pathname}${loc.search}${rest ? `#${rest}` : ""}`);
  return true;
};

/** Masks a key for display: `grad_abcd…wxyz`. */
export const maskKey = (key: string): string => (key.length <= 12 ? "•".repeat(key.length) : `${key.slice(0, 9)}…${key.slice(-4)}`);
