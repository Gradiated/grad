#!/usr/bin/env node
/**
 * Deterministic OpenAPI 3.x -> SDK transport generator (TypeScript, Python, Go, Rust).
 *
 * The spec is parsed once into a strict IR (scripts/codegen/ir.mjs); each
 * language emitter lives in scripts/codegen/<lang>.mjs (Python stays here).
 *
 * Usage:
 *   node scripts/generate-sdks.mjs          # regenerate every generated file
 *   node scripts/generate-sdks.mjs --check  # exit 1 if any generated file drifts from spec/openapi.yaml
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateGoFiles } from "./codegen/go.mjs";
import { buildIR, compareStrings, extractOperations, toCamel, toPascal, toSnake } from "./codegen/ir.mjs";
import { generateRustFile } from "./codegen/rust.mjs";
import { generateTypeScriptFiles } from "./codegen/typescript.mjs";

export { buildIR, extractOperations, toCamel, toPascal, toSnake };

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const requireFromApi = createRequire(
  path.join(repoRoot, "server", "api", "package.json"),
);
const YAML = requireFromApi("yaml");

const RESERVED_KEYWORDS = {
  py: new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "self", "body", "query"]),
};

export const safeIdent = (raw, lang) => {
  const base = toSnake(raw);
  if (RESERVED_KEYWORDS[lang]?.has(base)) return `${base}_`;
  return base;
};

const sanitizeSingleLine = (text) =>
  String(text ?? "")
    .replace(/\r?\n+/g, " ")
    .trim();

const escapePyDocstring = (text) =>
  sanitizeSingleLine(text).replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');

export const generatePython = (_spec, ops) => {
  const syncMethods = ops.map((op) => {
    const pyName = toSnake(op.operationId);
    const params = ["self"];
    for (const p of op.pathParams) params.push(`${safeIdent(p, "py")}: str`);
    if (op.hasBody) {
      params.push(
        op.bodyRequired
          ? "body: dict[str, Any]"
          : "body: dict[str, Any] | None = None",
      );
    }
    if (op.queryParams.length > 0) {
      params.push("*");
      for (const q of op.queryParams) {
        params.push(`${safeIdent(q.name, "py")}: Any = None`);
      }
    }

    const pathExpr = `f"${op.path.replace(/\{([^}]+)\}/g, (_, p) => `{urllib.parse.quote(${safeIdent(p, "py")}, safe='')}`)}"`;
    const queryLines =
      op.queryParams.length > 0
        ? `        _query = {${op.queryParams.map((q) => `"${q.name}": ${safeIdent(q.name, "py")}`).join(", ")}}`
        : "        _query = None";
    const bodyArg = op.hasBody ? "body=body" : "body=None";
    const callFn = op.isBinary ? "self._request_bytes" : "self._request_json";
    const retType = op.isBinary ? "tuple[bytes, dict[str, str]]" : "dict[str, Any]";

    return [
      `    def ${pyName}(${params.join(", ")}) -> ${retType}:`,
      `        """${escapePyDocstring(op.summary || op.operationId)}"""`,
      queryLines,
      `        return ${callFn}("${op.method}", ${pathExpr}, ${bodyArg}, query=_query)`,
    ].join("\n");
  });

  const asyncMethods = ops.map((op) => {
    const pyName = toSnake(op.operationId);
    const retType = op.isBinary ? "tuple[bytes, dict[str, str]]" : "dict[str, Any]";
    return [
      `    async def ${pyName}(self, *args: Any, **kwargs: Any) -> ${retType}:`,
      `        return await asyncio.to_thread(self._sync.${pyName}, *args, **kwargs)`,
    ].join("\n");
  });

  return `# AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.
"""Generated low-level wire clients for the Gradiated Training & Serving API."""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class GradApiError(RuntimeError):
    """RFC 7807 problem+json error raised by grad-server."""

    def __init__(
        self,
        *,
        status: int,
        code: str = "api_error",
        title: str = "API Error",
        detail: str = "",
        request_id: str = "",
    ) -> None:
        super().__init__(f"[{status}] {code}: {detail or title}")
        self.status = status
        self.code = code
        self.title = title
        self.detail = detail
        self.request_id = request_id


class GeneratedApiClient:
    """Synchronous stdlib HTTP client generated from spec/openapi.yaml."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(f"Unsupported base_url scheme: {parsed.scheme!r}")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_s = timeout_s

    def _build_url(self, route_path: str, query: dict[str, Any] | None) -> str:
        url = f"{self.base_url}{route_path}"
        if query:
            filtered = {k: str(v) for k, v in query.items() if v is not None}
            if filtered:
                url = f"{url}?{urllib.parse.urlencode(filtered)}"
        return url

    def _send(
        self,
        method: str,
        route_path: str,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> tuple[bytes, dict[str, str], int]:
        headers: dict[str, str] = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        data: bytes | None = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(
            self._build_url(route_path, query),
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                resp_headers = {k.lower(): v for k, v in resp.headers.items()}
                return resp.read(), resp_headers, int(resp.status)
        except urllib.error.HTTPError as exc:
            with exc:
                raw = exc.read().decode("utf-8", errors="replace")
            try:
                problem = json.loads(raw)
            except Exception:
                problem = {"status": exc.code, "detail": raw}
            raise GradApiError(
                status=int(problem.get("status", exc.code)),
                code=str(problem.get("code", "api_error")),
                title=str(problem.get("title", "API Error")),
                detail=str(problem.get("detail", raw)),
                request_id=str(problem.get("request_id", "")),
            ) from exc

    def _request_json(
        self,
        method: str,
        route_path: str,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raw, _, status = self._send(method, route_path, body=body, query=query)
        if status in (204, 205) or not raw.strip():
            return {}
        return json.loads(raw.decode("utf-8"))

    def _request_bytes(
        self,
        method: str,
        route_path: str,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> tuple[bytes, dict[str, str]]:
        raw, headers, _ = self._send(method, route_path, body=body, query=query)
        return raw, headers

${syncMethods.join("\n\n")}


class AsyncGeneratedApiClient:
    """Async wrapper over GeneratedApiClient using asyncio.to_thread."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        self._sync = GeneratedApiClient(
            base_url=base_url, api_key=api_key, timeout_s=timeout_s
        )

${asyncMethods.join("\n\n")}
`;
};

const readVersion = async (relPath, pattern) => {
  const text = await readFile(path.join(repoRoot, relPath), "utf8").catch(() => "");
  return pattern.exec(text)?.[1] ?? "0.0.0";
};

const PYTHON_INIT =
  "# AUTO-GENERATED by scripts/generate-sdks.mjs. DO NOT EDIT.\nfrom .client import AsyncGeneratedApiClient, GeneratedApiClient, GradApiError\n\n__all__ = ['AsyncGeneratedApiClient', 'GeneratedApiClient', 'GradApiError']\n";

/**
 * Generates every target from a parsed spec. `targets` limits the languages
 * (used by the fixture tests); output keys are repo-relative paths.
 */
export const generateFromSpec = async (spec, { targets = ["ts", "py", "go", "rs"], versions = {} } = {}) => {
  const ir = buildIR(spec);
  const ops = extractOperations(spec);
  const files = {};
  if (targets.includes("ts")) {
    const ts = await generateTypeScriptFiles(ir, { sdkVersion: versions.ts ?? "0.0.0" });
    for (const [name, content] of Object.entries(ts)) files[`sdks/typescript/src/generated/${name}`] = content;
  }
  if (targets.includes("py")) {
    files["sdks/python/grad/_generated/__init__.py"] = PYTHON_INIT;
    files["sdks/python/grad/_generated/client.py"] = generatePython(spec, ops);
  }
  if (targets.includes("go")) {
    const go = await generateGoFiles(ir, { sdkVersion: versions.go ?? "0.0.0" });
    for (const [name, content] of Object.entries(go)) files[`sdks/go/generated/${name}`] = content;
  }
  if (targets.includes("rs")) {
    files["sdks/rust/src/generated.rs"] = await generateRustFile(ir, { sdkVersion: versions.rs ?? "0.0.0" });
  }
  const sorted = {};
  for (const key of Object.keys(files).sort(compareStrings)) sorted[key] = files[key];
  return { ir, ops, files: sorted };
};

export const parseSpecFile = async (specPath) => YAML.parse(await readFile(specPath, "utf8"));

export const generateAllTargets = async (specPath) => {
  const spec = await parseSpecFile(specPath);
  const versions = {
    ts: await readVersion("sdks/typescript/package.json", /"version":\s*"([^"]+)"/),
    go: await readVersion("sdks/go/version.go", /Version = "([^"]+)"/),
    rs: await readVersion("sdks/rust/Cargo.toml", /^version = "([^"]+)"/m),
  };
  return generateFromSpec(spec, { versions });
};

const main = async () => {
  const check = process.argv.includes("--check");
  const specPath = path.join(repoRoot, "spec", "openapi.yaml");
  const { ops, files } = await generateAllTargets(specPath);

  if (check) {
    const drifted = [];
    for (const [relPath, expected] of Object.entries(files)) {
      const fullPath = path.join(repoRoot, relPath);
      const actual = await readFile(fullPath, "utf8").catch(() => null);
      if (actual !== expected) drifted.push(relPath);
    }
    if (drifted.length > 0) {
      console.error(
        `SDK codegen drift detected (${drifted.length} files):\n- ${drifted.join("\n- ")}\nRun 'node scripts/generate-sdks.mjs'.`,
      );
      process.exit(1);
    }
    console.log(
      `All ${Object.keys(files).length} generated SDK files (${ops.length} operations) are up to date.`,
    );
    return;
  }

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    console.log(`Wrote ${relPath}`);
  }
  console.log(`Generated ${ops.length} operations across 4 languages.`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
