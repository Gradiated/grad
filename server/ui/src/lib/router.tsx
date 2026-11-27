import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";

// A tiny History API router: the UI is served at `/`, the API lives at `/v1`.

export interface Location {
  path: string;
  query: URLSearchParams;
}

const current = (): Location => ({ path: location.pathname.replace(/\/+$/, "") || "/", query: new URLSearchParams(location.search) });

const RouterContext = createContext<Location>({ path: "/", query: new URLSearchParams() });

export const navigate = (to: string, opts: { replace?: boolean } = {}): void => {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
};

export const RouterProvider = ({ children }: { children: ReactNode }) => {
  const [loc, setLoc] = useState(current);
  useEffect(() => {
    const on = () => {
      setLoc(current());
      window.scrollTo?.(0, 0);
    };
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return <RouterContext.Provider value={loc}>{children}</RouterContext.Provider>;
};

export const useLocation = (): Location => useContext(RouterContext);

/** Matches `/runs/:id` style patterns; returns decoded params or null. */
export const match = (pattern: string, path: string): Record<string, string> | null => {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i] as string;
    const seg = s[i] as string;
    if (part.startsWith(":")) {
      try {
        params[part.slice(1)] = decodeURIComponent(seg);
      } catch {
        return null;
      }
    } else if (part !== seg) return null;
  }
  return params;
};

/** Replaces query parameters in the current URL without adding history entries. */
export const setQuery = (updates: Record<string, string | undefined>): void => {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === "") q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  navigate(`${location.pathname}${s ? `?${s}` : ""}`, { replace: true });
};

export const Link = ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a {...rest} href={href} onClick={onClick}>
      {children}
    </a>
  );
};
