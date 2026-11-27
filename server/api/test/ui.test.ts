import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseServerEnvironment } from "../src/environment.js";
import { loadUiBundle, resolveUiBundle, UI_CSP } from "../src/ui.js";
import { makeTestApp, type TestApp } from "./fixtures/app.js";

// A UI build as Vite lays it out: index.html, hashed assets, a public file.
const makeBuild = (): string => {
  const dir = mkdtempSync(
    path.join(process.env.TMPDIR ?? os.tmpdir(), "grad-ui-"),
  );
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(
    path.join(dir, "index.html"),
    '<!doctype html><html><head><script type="module" src="/assets/index-abc123.js"></script></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(
    path.join(dir, "assets", "index-abc123.js"),
    `console.log(${JSON.stringify("x".repeat(4000))});`,
  );
  writeFileSync(path.join(dir, "assets", "index-def456.css"), "body{margin:0}");
  writeFileSync(path.join(dir, "favicon.svg"), "<svg/>");
  return dir;
};

const html = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

describe("web UI", () => {
  let t: TestApp;
  const dir = makeBuild();

  beforeAll(async () => {
    t = await makeTestApp({ ui: loadUiBundle(dir) });
  });
  afterAll(async () => {
    await t.close();
  });

  it("serves index.html at / with a strict CSP and no caching", async () => {
    const res = await t.request("/", { token: null, headers: html });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-security-policy")).toBe(UI_CSP);
    expect(UI_CSP).toContain("script-src 'self'");
    expect(UI_CSP).toContain("frame-ancestors 'none'");
    expect(UI_CSP).not.toContain("unsafe-inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain('<div id="root">');
  });

  it("falls back to index.html for client routes such as /runs/run_x", async () => {
    for (const p of [
      "/runs/run_x",
      "/datasets/support",
      "/health",
      "/index.html",
    ]) {
      const res = await t.request(p, { token: null, headers: html });
      expect(res.status, p).toBe(200);
      expect(res.headers.get("content-type"), p).toContain("text/html");
    }
  });

  it("keeps /v1 404s as problem+json, never HTML", async () => {
    const res = await t.request("/v1/nope", { headers: html });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "route_not_found",
    });
    const anon = await t.request("/v1/nope", { token: null, headers: html });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("does not answer API, probe and non-browser paths with HTML", async () => {
    for (const p of [
      "/health/nope",
      "/healthz",
      "/metrics",
      "/assets/missing.js",
    ]) {
      const res = await t.request(p, { token: null, headers: html });
      expect(res.status, p).toBe(404);
      expect(res.headers.get("content-type"), p).toContain(
        "application/problem+json",
      );
    }
    const curl = await t.request("/runs/run_x", {
      token: null,
      headers: { accept: "*/*" },
    });
    expect(curl.status).toBe(404);
    const post = await t.request("/runs/run_x", {
      token: null,
      method: "POST",
      body: "x",
      headers: html,
    });
    expect(post.status).toBe(404);
    expect(
      (
        await t.request("/health/live", { token: null, headers: html })
      ).headers.get("content-type"),
    ).toContain("application/json");
  });

  it("serves hashed assets as immutable with gzip and ETags", async () => {
    const res = await t.request("/assets/index-abc123.js", {
      token: null,
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
    expect(body).toContain("console.log");

    const css = await t.request("/assets/index-def456.css", { token: null });
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("content-encoding")).toBeNull();
    expect(await css.text()).toBe("body{margin:0}");

    const etag = css.headers.get("etag") as string;
    const cached = await t.request("/assets/index-def456.css", {
      token: null,
      headers: { "if-none-match": etag },
    });
    expect(cached.status).toBe(304);

    const icon = await t.request("/favicon.svg", {
      token: null,
      method: "HEAD",
    });
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("cache-control")).toBe("no-cache");
  });

  it("without a UI bundle, browser paths stay JSON 404s", async () => {
    const bare = await makeTestApp();
    try {
      const res = await bare.request("/runs/run_x", {
        token: null,
        headers: html,
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain(
        "application/problem+json",
      );
    } finally {
      await bare.close();
    }
  });
});

describe("UI configuration", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    ADMIN_API_KEY_HASH: "a".repeat(64),
  };

  it("is on by default, off by default in cloud mode, and UI_ENABLED overrides both", () => {
    expect(parseServerEnvironment(base).uiEnabled).toBe(true);
    expect(
      parseServerEnvironment({ ...base, AUTH_MODE: "none" }).uiEnabled,
    ).toBe(true);
    const cloud = {
      ...base,
      AUTH_MODE: "cloud",
      CLOUD_INTERNAL_API_URL: "http://c",
      CLOUD_SERVICE_TOKEN: "t",
    };
    expect(parseServerEnvironment(cloud).uiEnabled).toBe(false);
    expect(
      parseServerEnvironment({ ...cloud, UI_ENABLED: "true" }).uiEnabled,
    ).toBe(true);
    expect(parseServerEnvironment({ ...base, UI_ENABLED: "0" }).uiEnabled).toBe(
      false,
    );
  });

  it("finds a build in UI_DIR and returns null for a directory without index.html", () => {
    const dir = makeBuild();
    expect(resolveUiBundle(dir)?.files.has("/assets/index-abc123.js")).toBe(
      true,
    );
    expect(resolveUiBundle(os.tmpdir() + "/grad-ui-missing")).toBeNull();
    expect(loadUiBundle(path.join(dir, "assets"))).toBeNull();
  });
});

// The real Vite build (CI builds server/ui before these tests): every asset
// index.html references is served, and nothing in it needs 'unsafe-inline'.
const realBuild = path.resolve(import.meta.dirname, "../../ui/dist");

describe.skipIf(!existsSync(path.join(realBuild, "index.html")))(
  "web UI build smoke",
  () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await makeTestApp({ ui: loadUiBundle(realBuild) });
    });
    afterAll(async () => {
      await t.close();
    });

    it("serves the built index.html and every asset it references, CSP-clean", async () => {
      const res = await t.request("/runs/run_x", {
        token: null,
        headers: html,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(UI_CSP);
      const page = await res.text();
      // No inline scripts, inline styles or event-handler attributes.
      expect(page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(page).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
      const refs = [...page.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(
        (m) => m[1] as string,
      );
      expect(
        refs.some((r) => r.startsWith("/assets/") && r.endsWith(".js")),
      ).toBe(true);
      expect(refs.some((r) => r.endsWith(".css"))).toBe(true);
      for (const ref of refs) {
        const asset = await t.request(ref, { token: null });
        expect(asset.status, ref).toBe(200);
        if (ref.startsWith("/assets/")) {
          expect(ref, ref).toMatch(/-[A-Za-z0-9_-]{8,}\.(js|css)$/);
          expect(asset.headers.get("cache-control")).toContain("immutable");
        }
      }
    });
  },
);
