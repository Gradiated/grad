import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import type { Context } from "hono";

/**
 * The web UI (server/ui, a static Vite build) served from memory at `/`:
 * hashed files under `/assets/*` are immutable, index.html is revalidated,
 * and any other browser navigation outside the API falls back to index.html
 * so client-side routes such as `/runs/run_123` load directly. The UI only
 * calls the public `/v1` API, so it adds no endpoints of its own.
 */

/** Strict CSP: no inline scripts or styles, same-origin fetches only, no framing. */
export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": UI_CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const COMPRESSIBLE = /^(text\/|application\/(json|manifest)|image\/svg)/;

interface StaticFile {
  body: Uint8Array;
  gzip: Uint8Array | null;
  type: string;
  etag: string;
  /** Hashed (content-addressed) file: cache forever. */
  immutable: boolean;
}

export interface UiBundle {
  dir: string;
  index: StaticFile;
  /** URL path (e.g. `/assets/index-abc.js`, `/favicon.svg`) to file. */
  files: Map<string, StaticFile>;
}

const load = (file: string, immutable: boolean): StaticFile => {
  const body = readFileSync(file);
  const type =
    TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const gzip =
    COMPRESSIBLE.test(type) && body.length > 1024
      ? gzipSync(body, { level: 9 })
      : null;
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`;
  return {
    body,
    gzip: gzip && gzip.length < body.length ? gzip : null,
    type,
    etag,
    immutable,
  };
};

const walk = (
  dir: string,
  prefix: string,
  out: Map<string, StaticFile>,
  immutable: boolean,
) => {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const url = `${prefix}/${name}`;
    if (statSync(full).isDirectory()) walk(full, url, out, immutable);
    else if (url !== "/index.html") out.set(url, load(full, immutable));
  }
};

/** Loads a built UI directory into memory; null when it has no index.html. */
export const loadUiBundle = (dir: string): UiBundle | null => {
  const indexPath = path.join(dir, "index.html");
  if (!existsSync(indexPath)) return null;
  const files = new Map<string, StaticFile>();
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (name.startsWith(".") || name === "index.html") continue;
    if (statSync(full).isDirectory())
      walk(full, `/${name}`, files, name === "assets");
    else files.set(`/${name}`, load(full, false));
  }
  return { dir, index: load(indexPath, false), files };
};

/** Where a built UI lives: UI_DIR, the image's `/app/ui`, or a checkout's `server/ui/dist`. */
export const defaultUiDirs = (): string[] => {
  const apiRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  return [path.join(apiRoot, "ui"), path.resolve(apiRoot, "../ui/dist")];
};

export const resolveUiBundle = (
  explicit: string | undefined,
): UiBundle | null => {
  for (const dir of explicit ? [explicit] : defaultUiDirs()) {
    const bundle = loadUiBundle(dir);
    if (bundle) return bundle;
  }
  return null;
};

/** Paths that are never the SPA: the API, health probes, metrics, the spec and assets (the UI's own `/health` page is a route). */
const NOT_UI =
  /^\/(v1(\/|$)|health\/|healthz$|readyz$|livez$|metrics$|openapi\.json$|assets\/)/;

const acceptsHtml = (c: Context): boolean =>
  (c.req.header("accept") ?? "").includes("text/html");

const respond = (
  c: Context,
  file: StaticFile,
  requestId: string | undefined,
): Response => {
  const headers = new Headers({
    "Content-Type": file.type,
    "Cache-Control": file.immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    ETag: file.etag,
    Vary: "Accept-Encoding",
    ...SECURITY_HEADERS,
  });
  if (requestId) headers.set("x-request-id", requestId);
  if (c.req.header("if-none-match") === file.etag)
    return new Response(null, { status: 304, headers });
  const gzip =
    file.gzip && /\bgzip\b/.test(c.req.header("accept-encoding") ?? "");
  const body = gzip ? (file.gzip as Uint8Array) : file.body;
  if (gzip) headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(body.length));
  return new Response(
    c.req.method === "HEAD" ? null : (body as Uint8Array<ArrayBuffer>),
    { status: 200, headers },
  );
};

/** A static file at this exact path (assets and top-level files such as favicon.svg). */
export const serveUiFile = (
  c: Context,
  bundle: UiBundle,
  requestId?: string,
): Response | null => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return null;
  const file = bundle.files.get(c.req.path);
  return file ? respond(c, file, requestId) : null;
};

/** index.html for a browser navigation outside the API; null otherwise. */
export const serveUiFallback = (
  c: Context,
  bundle: UiBundle,
  requestId?: string,
): Response | null => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return null;
  if (NOT_UI.test(c.req.path) || !acceptsHtml(c)) return null;
  return respond(c, bundle.index, requestId);
};
