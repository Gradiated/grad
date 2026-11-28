import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { IconArtifacts, IconDatasets, IconEvals, IconHealth, IconLogout, IconMoon, IconRuns, IconSun, IconUsage, Wordmark } from "./components/icons.js";
import { Empty, ToastProvider } from "./components/ui.js";
import { ApiContext, createApi, errorMessage, isUnauthorized, type Api } from "./lib/api.js";
import { maskKey, sessionKeyStore, takeFragmentKey, type KeyStore } from "./lib/auth.js";
import { Link, match, RouterProvider, useLocation } from "./lib/router.js";
import { setTheme, useTheme } from "./lib/theme.js";
import { ArtifactDetailPage, ArtifactsPage } from "./pages/artifacts.js";
import { DatasetDetailPage, DatasetsPage } from "./pages/datasets.js";
import { EvalDetailPage, EvalsPage } from "./pages/evals.js";
import { HealthPage } from "./pages/health.js";
import { LoginPage } from "./pages/login.js";
import { RunDetailPage } from "./pages/run-detail.js";
import { RunsPage } from "./pages/runs.js";
import { UsagePage } from "./pages/usage.js";

type Session = { state: "checking" } | { state: "login"; reason?: string } | { state: "ready"; api: Api; key: string | undefined };

export interface AppProps {
  baseURL?: string;
  store?: KeyStore;
  fetch?: typeof fetch;
}

/** Root: resolves the API key (fragment handoff, sessionStorage, or none needed), then the app. */
export const App = ({ baseURL = location.origin, store: given, fetch: fetchImpl }: AppProps) => {
  const store = useMemo(() => given ?? sessionKeyStore(), [given]);
  const [session, setSession] = useState<Session>({ state: "checking" });

  const connect = useCallback(
    async (key: string | undefined): Promise<string | null> => {
      let unauthorized = false;
      // Any 401 later (key revoked, server restarted with new keys) returns to the login page.
      const guarded: typeof fetch = async (input, init) => {
        const res = await (fetchImpl ?? globalThis.fetch)(input, init);
        if (res.status === 401 && unauthorized) {
          store.clear();
          setSession({ state: "login", reason: "Your session ended: the server rejected the API key." });
        }
        return res;
      };
      const api = createApi(baseURL, key, guarded);
      try {
        await api.client.listRuns({ limit: 1 });
      } catch (e) {
        if (isUnauthorized(e)) return key ? "The server rejected that key." : "";
        return `Cannot reach grad-server: ${errorMessage(e)}`;
      }
      unauthorized = true;
      if (key) store.set(key);
      setSession({ state: "ready", api, key });
      return null;
    },
    [baseURL, fetchImpl, store],
  );

  useEffect(() => {
    takeFragmentKey(store);
    const key = store.get();
    void connect(key).then((problem) => {
      if (problem === null) return;
      if (key) store.clear();
      setSession(problem ? { state: "login", reason: problem } : { state: "login" });
    });
  }, [connect, store]);

  const signOut = useCallback(() => {
    store.clear();
    setSession({ state: "login" });
  }, [store]);

  if (session.state === "checking") return <div className="login" aria-busy="true" />;
  if (session.state === "login") return <LoginPage reason={session.reason} onSubmit={connect} />;
  return (
    <ApiContext.Provider value={session.api}>
      <ToastProvider>
        <RouterProvider>
          <Shell apiKey={session.key} onSignOut={signOut} />
        </RouterProvider>
      </ToastProvider>
    </ApiContext.Provider>
  );
};

const NAV: { href: string; label: string; icon: ReactNode; prefix: string[] }[] = [
  { href: "/runs", label: "Runs", icon: <IconRuns />, prefix: ["/", "/runs"] },
  { href: "/datasets", label: "Datasets", icon: <IconDatasets />, prefix: ["/datasets"] },
  { href: "/artifacts", label: "Artifacts", icon: <IconArtifacts />, prefix: ["/artifacts"] },
  { href: "/evals", label: "Evals", icon: <IconEvals />, prefix: ["/evals"] },
  { href: "/usage", label: "Usage", icon: <IconUsage />, prefix: ["/usage"] },
  { href: "/health", label: "Health", icon: <IconHealth />, prefix: ["/health"] },
];

const isActive = (path: string, prefixes: string[]) => prefixes.some((p) => (p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`)));

const Shell = ({ apiKey, onSignOut }: { apiKey: string | undefined; onSignOut: () => void }) => {
  const { path } = useLocation();
  const page = route(path);
  useEffect(() => {
    document.title = page.title ? `${page.title} · grad` : "grad";
  }, [page.title]);
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <nav className="sidebar-inner" aria-label="Main">
          <Link href="/runs" className="brand" aria-label="grad: runs">
            <Wordmark />
            <span className="brand-sub caps">Training</span>
          </Link>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`nav-item${isActive(path, n.prefix) ? " active" : ""}`} aria-current={isActive(path, n.prefix) ? "page" : undefined}>
              {n.icon}
              {n.label}
            </Link>
          ))}
          <div className="sidebar-foot">
            <div className="row" title={location.origin}>
              <span className="host mono">{location.host}</span>
              <ThemeToggle />
            </div>
            <div className="row">
              <span className="host faint mono">{apiKey ? maskKey(apiKey) : "no auth (local)"}</span>
              {apiKey && (
                <button type="button" className="btn ghost sm icon push" onClick={onSignOut} title="Sign out" aria-label="Sign out">
                  <IconLogout />
                </button>
              )}
            </div>
          </div>
        </nav>
      </aside>
      <main className="main" id="main" tabIndex={-1}>
        <Offline />
        {page.node}
      </main>
    </div>
  );
};

/** The browser's own offline signal: requests will fail until it reconnects. */
const Offline = () => {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine !== false);
    addEventListener("online", on);
    addEventListener("offline", on);
    return () => {
      removeEventListener("online", on);
      removeEventListener("offline", on);
    };
  }, []);
  return online ? null : (
    <div className="offline" role="status">
      You're offline. Pages show what they last loaded and refresh when the connection returns.
    </div>
  );
};

const ThemeToggle = () => {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className="btn ghost sm icon push" onClick={() => setTheme(next)} title={`Switch to the ${next} theme`} aria-label={`Switch to the ${next} theme`}>
      {theme === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );
};

/** Maps a path to its page. */
export const route = (path: string): { node: ReactNode; title: string } => {
  let m: Record<string, string> | null;
  if (path === "/" || path === "/runs") return { node: <RunsPage />, title: "Runs" };
  if ((m = match("/runs/:id", path))) return { node: <RunDetailPage key={m.id} id={m.id as string} />, title: m.id as string };
  if (path === "/datasets") return { node: <DatasetsPage />, title: "Datasets" };
  if ((m = match("/datasets/:name", path))) return { node: <DatasetDetailPage key={m.name} name={m.name as string} />, title: m.name as string };
  if (path === "/artifacts") return { node: <ArtifactsPage />, title: "Artifacts" };
  if ((m = match("/artifacts/:id", path))) return { node: <ArtifactDetailPage key={m.id} id={m.id as string} />, title: m.id as string };
  if (path === "/evals") return { node: <EvalsPage />, title: "Evals" };
  if ((m = match("/evals/:id", path))) return { node: <EvalDetailPage key={m.id} id={m.id as string} />, title: m.id as string };
  if (path === "/usage") return { node: <UsagePage />, title: "Usage" };
  if (path === "/health") return { node: <HealthPage />, title: "Health" };
  return {
    title: "Not found",
    node: (
      <div className="page">
        <h1 className="sr-only">Not found</h1>
        <Empty title="Nothing here">
          <Link className="link" href="/runs">
            Go to runs
          </Link>
        </Empty>
      </div>
    ),
  };
};
