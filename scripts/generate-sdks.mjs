#!/usr/bin/env node
/**
 * Deterministic OpenAPI 3.1 -> 4-language (TypeScript, Python, Go, Rust) wire client generator.
 *
 * Usage:
 *   node scripts/generate-sdks.mjs          # regenerate all 4 generated clients
 *   node scripts/generate-sdks.mjs --check  # exit 1 if any generated file drifts from spec/openapi.yaml
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const requireFromApi = createRequire(
  path.join(repoRoot, "server", "api", "package.json"),
);
const YAML = requireFromApi("yaml");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const RESERVED_KEYWORDS = {
  ts: new Set(["class", "default", "delete", "export", "function", "import", "in", "return", "switch", "var", "void"]),
  py: new Set(["class", "def", "del", "from", "global", "import", "in", "lambda", "match", "pass", "return", "with"]),
  go: new Set(["chan", "default", "defer", "func", "go", "import", "interface", "map", "package", "range", "return", "select", "struct", "type", "var"]),
  rs: new Set(["as", "async", "await", "crate", "fn", "impl", "in", "let", "loop", "match", "mod", "move", "pub", "ref", "return", "self", "struct", "trait", "type", "use", "where"]),
};

export const toSnake = (name) =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

export const toPascal = (name) =>
  name
    .replace(/(^|[_-])([a-zA-Z0-9])/g, (_, _sep, ch) => ch.toUpperCase())
    .replace(/([a-z0-9])Id$/g, "$1ID");

export const toCamel = (name) =>
  name.replace(/[_-]([a-zA-Z0-9])/g, (_, ch) => ch.toUpperCase());

export const safeIdent = (raw, lang) => {
  const base =
    lang === "py" || lang === "rs" ? toSnake(raw) : toCamel(raw);
  if (RESERVED_KEYWORDS[lang]?.has(base)) {
    return lang === "rs" ? `r#${base}` : `${base}_`;
  }
  return base;
};

const sanitizeSingleLine = (text) =>
  String(text ?? "")
    .replace(/\r?\n+/g, " ")
    .trim();

const escapeTsComment = (text) =>
  sanitizeSingleLine(text).replace(/\*\//g, "*\\/");

const escapePyDocstring = (text) =>
  sanitizeSingleLine(text).replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');

export const extractOperations = (spec) => {
  const ops = [];
  const seenIds = new Set();
  const paths = spec.paths ?? {};

  for (const [routePath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const sharedParams = Array.isArray(pathItem.parameters)
      ? pathItem.parameters
      : [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || !op.operationId) continue;

      if (!IDENT_RE.test(op.operationId)) {
        throw new Error(`Invalid operationId '${op.operationId}' on ${method.toUpperCase()} ${routePath}.`);
      }
      const normKey = toSnake(op.operationId);
      if (seenIds.has(normKey)) {
        throw new Error(`Duplicate operationId '${op.operationId}' (normalized: '${normKey}').`);
      }
      seenIds.add(normKey);

      const mergedParams = [
        ...sharedParams,
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ];
      const pathParams = mergedParams
        .filter((p) => p && p.in === "path")
        .map((p) => p.name);
      const queryParams = mergedParams
        .filter((p) => p && p.in === "query")
        .map((p) => ({ name: p.name, required: Boolean(p.required) }));
      const hasBody = Boolean(op.requestBody);
      const bodyRequired = Boolean(op.requestBody?.required);
      const successEntry = Object.entries(op.responses ?? {}).find(([code]) =>
        code.startsWith("2"),
      );
      const isBinary = Boolean(
        successEntry?.[1]?.content?.["application/octet-stream"],
      );

      ops.push({
        operationId: op.operationId,
        summary: op.summary ?? "",
        method: method.toUpperCase(),
        path: routePath,
        pathParams,
        queryParams,
        hasBody,
        bodyRequired,
        isBinary,
      });
    }
  }
  return ops.sort((a, b) => a.operationId.localeCompare(b.operationId));
};

const schemaToTsType = (schema) => {
  if (!schema || typeof schema !== "object") return "unknown";
  if (schema.$ref) {
    return schema.$ref.split("/").pop() ?? "unknown";
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map(schemaToTsType).join(" & ");
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map(schemaToTsType).join(" | ");
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map(schemaToTsType).join(" | ");
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  if (Array.isArray(schema.type)) {
    return schema.type
      .map((t) => schemaToTsType({ ...schema, type: t }))
      .join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${schemaToTsType(schema.items)}>`;
    case "object": {
      if (schema.properties && Object.keys(schema.properties).length > 0) {
        const required = new Set(schema.required ?? []);
        const fields = Object.entries(schema.properties).map(([k, v]) => {
          const opt = required.has(k) ? "" : "?";
          const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)
            ? k
            : JSON.stringify(k);
          return `  ${safeKey}${opt}: ${schemaToTsType(v)};`;
        });
        return `{\n${fields.join("\n")}\n}`;
      }
      if (schema.additionalProperties === false) {
        return "Record<string, never>";
      }
      if (schema.additionalProperties) {
        const valType =
          schema.additionalProperties === true
            ? "unknown"
            : schemaToTsType(schema.additionalProperties);
        return `Record<string, ${valType}>`;
      }
      return "Record<string, unknown>";
    }
    default:
      return "unknown";
  }
};

export const generateTypeScript = (spec, ops) => {
  const schemas = spec.components?.schemas ?? {};
  const typeBlocks = Object.keys(schemas)
    .sort()
    .map((name) => `export type ${name} = ${schemaToTsType(schemas[name])};`);

  const methods = ops.map((op) => {
    const args = [];
    for (const p of op.pathParams) args.push(`${safeIdent(p, "ts")}: string`);
    if (op.hasBody) {
      args.push(
        `body${op.bodyRequired ? "" : "?"}: Record<string, unknown>`,
      );
    }
    if (op.queryParams.length > 0) {
      const qFields = op.queryParams
        .map((q) => `${q.name}?: string | number | boolean`)
        .join("; ");
      args.push(`query?: { ${qFields} }`);
    }

    const pathExpr = `\`${op.path.replace(/\{([^}]+)\}/g, (_, p) => `\${encodeURIComponent(${safeIdent(p, "ts")})}`)}\``;
    const callFn = op.isBinary ? "this.requestBytes" : "this.requestJson";
    const retType = op.isBinary
      ? "Promise<{ bytes: Uint8Array; headers: Headers }>"
      : "Promise<Record<string, unknown>>";

    const optParts = [`method: "${op.method}"`];
    if (op.hasBody) optParts.push("body");
    if (op.queryParams.length > 0) optParts.push("query");

    return [
      `  /** ${escapeTsComment(op.summary || op.operationId)} */`,
      `  ${op.operationId}(${args.join(", ")}): ${retType} {`,
      `    return ${callFn}(${pathExpr}, { ${optParts.join(", ")} });`,
      `  }`,
    ].join("\n");
  });

  return `// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.
/* eslint-disable */

${typeBlocks.join("\n\n")}

export class GradApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly requestId: string;

  constructor(problem: {
    status: number;
    code?: string;
    title?: string;
    detail?: string;
    request_id?: string;
  }) {
    super(\`[\${problem.status}] \${problem.code ?? "api_error"}: \${problem.detail ?? problem.title ?? "Request failed"}\`);
    this.name = "GradApiError";
    this.status = problem.status;
    this.code = problem.code ?? "api_error";
    this.title = problem.title ?? "API Error";
    this.detail = problem.detail ?? "";
    this.requestId = problem.request_id ?? "";
  }
}

export interface GeneratedClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GeneratedApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeneratedClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(\`Unsupported baseUrl protocol: \${parsed.protocol}\`);
    }
    this.baseUrl = options.baseUrl.replace(/\\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private buildUrl(
    routePath: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(\`\${this.baseUrl}\${routePath}\`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async send(
    routePath: string,
    options: {
      method: string;
      body?: Record<string, unknown> | undefined;
      query?: Record<string, string | number | boolean | undefined> | undefined;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["Authorization"] = \`Bearer \${this.apiKey}\`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetchImpl(this.buildUrl(routePath, options.query), {
      method: options.method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      let problem: Record<string, unknown> = { status: response.status, detail: text };
      try {
        problem = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Non-JSON proxy/gateway error body; keep raw text fallback.
      }
      throw new GradApiError({
        status: Number(problem.status ?? response.status),
        ...(typeof problem.code === "string" ? { code: problem.code } : {}),
        ...(typeof problem.title === "string" ? { title: problem.title } : {}),
        ...(typeof problem.detail === "string" ? { detail: problem.detail } : {}),
        ...(typeof problem.request_id === "string"
          ? { request_id: problem.request_id }
          : {}),
      });
    }

    return response;
  }

  protected async requestJson(
    routePath: string,
    options: {
      method: string;
      body?: Record<string, unknown> | undefined;
      query?: Record<string, string | number | boolean | undefined> | undefined;
    },
  ): Promise<Record<string, unknown>> {
    const response = await this.send(routePath, options);
    if (response.status === 204 || response.status === 205) return {};
    const text = await response.text();
    if (!text.trim()) return {};
    return JSON.parse(text) as Record<string, unknown>;
  }

  protected async requestBytes(
    routePath: string,
    options: {
      method: string;
      body?: Record<string, unknown> | undefined;
      query?: Record<string, string | number | boolean | undefined> | undefined;
    },
  ): Promise<{ bytes: Uint8Array; headers: Headers }> {
    const response = await this.send(routePath, options);
    const buf = new Uint8Array(await response.arrayBuffer());
    return { bytes: buf, headers: response.headers };
  }

${methods.join("\n\n")}
}
`;
};

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

export const generateGo = (_spec, ops) => {
  const methods = ops.map((op) => {
    const goName = toPascal(op.operationId);
    const params = ["ctx context.Context"];
    for (const p of op.pathParams) params.push(`${safeIdent(p, "go")} string`);
    if (op.hasBody) params.push("body any");
    if (op.queryParams.length > 0) params.push("query map[string]string");

    let pathBuild = JSON.stringify(op.path);
    if (op.pathParams.length > 0) {
      const fmtStr = op.path.replace(/\{([^}]+)\}/g, "%s");
      const args = op.pathParams
        .map((p) => `url.PathEscape(${safeIdent(p, "go")})`)
        .join(", ");
      pathBuild = `fmt.Sprintf(${JSON.stringify(fmtStr)}, ${args})`;
    }

    const bodyArg = op.hasBody ? "body" : "nil";
    const queryArg = op.queryParams.length > 0 ? "query" : "nil";
    const doc = sanitizeSingleLine(op.summary || op.operationId);

    if (op.isBinary) {
      return [
        `// ${goName}: ${doc}`,
        `func (c *Client) ${goName}(${params.join(", ")}) ([]byte, http.Header, error) {`,
        `\treturn c.doBytes(ctx, "${op.method}", ${pathBuild}, ${bodyArg}, ${queryArg})`,
        `}`,
      ].join("\n");
    }

    return [
      `// ${goName}: ${doc}`,
      `func (c *Client) ${goName}(${params.join(", ")}) (map[string]any, error) {`,
      `\treturn c.doJSON(ctx, "${op.method}", ${pathBuild}, ${bodyArg}, ${queryArg})`,
      `}`,
    ].join("\n");
  });

  return `// Code generated from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.

package generated

import (
\t"bytes"
\t"context"
\t"encoding/json"
\t"fmt"
\t"io"
\t"net/http"
\t"net/url"
\t"strings"
\t"time"
)

// APIError represents an RFC 7807 problem+json response from grad-server.
type APIError struct {
\tStatus    int    \`json:"status"\`
\tCode      string \`json:"code"\`
\tTitle     string \`json:"title"\`
\tDetail    string \`json:"detail"\`
\tRequestID string \`json:"request_id"\`
}

func (e *APIError) Error() string {
\treturn fmt.Sprintf("[%d] %s: %s", e.Status, e.Code, e.Detail)
}

// Client is the generated low-level wire client for grad-server.
type Client struct {
\tBaseURL    string
\tAPIKey     string
\tHTTPClient *http.Client
}

// NewClient creates a generated wire client with a 30s default timeout.
func NewClient(baseURL, apiKey string, httpClient *http.Client) *Client {
\tif httpClient == nil {
\t\thttpClient = &http.Client{Timeout: 30 * time.Second}
\t}
\treturn &Client{
\t\tBaseURL:    strings.TrimRight(baseURL, "/"),
\t\tAPIKey:     apiKey,
\t\tHTTPClient: httpClient,
\t}
}

func (c *Client) send(ctx context.Context, method, routePath string, body any, query map[string]string) ([]byte, http.Header, int, error) {
\tfullURL := c.BaseURL + routePath
\tif len(query) > 0 {
\t\tvals := url.Values{}
\t\tfor k, v := range query {
\t\t\tif v != "" {
\t\t\t\tvals.Set(k, v)
\t\t\t}
\t\t}
\t\tif encoded := vals.Encode(); encoded != "" {
\t\t\tfullURL += "?" + encoded
\t\t}
\t}

\tvar reader io.Reader
\tif body != nil {
\t\traw, err := json.Marshal(body)
\t\tif err != nil {
\t\t\treturn nil, nil, 0, err
\t\t}
\t\treader = bytes.NewReader(raw)
\t}

\treq, err := http.NewRequestWithContext(ctx, method, fullURL, reader)
\tif err != nil {
\t\treturn nil, nil, 0, err
\t}
\tif c.APIKey != "" {
\t\treq.Header.Set("Authorization", "Bearer "+c.APIKey)
\t}
\tif body != nil {
\t\treq.Header.Set("Content-Type", "application/json")
\t}

\tresp, err := c.HTTPClient.Do(req)
\tif err != nil {
\t\treturn nil, nil, 0, err
\t}
\tdefer resp.Body.Close()

\tpayload, err := io.ReadAll(resp.Body)
\tif err != nil {
\t\treturn nil, nil, resp.StatusCode, err
\t}

\tif resp.StatusCode < 200 || resp.StatusCode >= 300 {
\t\tapiErr := &APIError{Status: resp.StatusCode, Code: "api_error", Detail: string(payload)}
\t\t_ = json.Unmarshal(payload, apiErr)
\t\tif apiErr.Status == 0 {
\t\t\tapiErr.Status = resp.StatusCode
\t\t}
\t\treturn nil, resp.Header, resp.StatusCode, apiErr
\t}

\treturn payload, resp.Header, resp.StatusCode, nil
}

func (c *Client) doJSON(ctx context.Context, method, routePath string, body any, query map[string]string) (map[string]any, error) {
\tpayload, _, status, err := c.send(ctx, method, routePath, body, query)
\tif err != nil {
\t\treturn nil, err
\t}
\tif status == http.StatusNoContent || status == http.StatusResetContent || len(bytes.TrimSpace(payload)) == 0 {
\t\treturn map[string]any{}, nil
\t}
\tvar out map[string]any
\tif err := json.Unmarshal(payload, &out); err != nil {
\t\treturn nil, err
\t}
\treturn out, nil
}

func (c *Client) doBytes(ctx context.Context, method, routePath string, body any, query map[string]string) ([]byte, http.Header, error) {
\tpayload, headers, _, err := c.send(ctx, method, routePath, body, query)
\treturn payload, headers, err
}

${methods.join("\n\n")}
`;
};

export const generateRust = (_spec, ops) => {
  const methods = ops.map((op) => {
    const fnName = toSnake(op.operationId);
    const params = ["&self"];
    for (const p of op.pathParams) params.push(`${safeIdent(p, "rs")}: &str`);
    if (op.hasBody) {
      params.push(
        op.bodyRequired ? "body: &Value" : "body: Option<&Value>",
      );
    }
    if (op.queryParams.length > 0) {
      params.push("query: &[(&str, String)]");
    }

    let pathExpr = `${JSON.stringify(op.path)}.to_string()`;
    if (op.pathParams.length > 0) {
      const fmtStr = op.path.replace(/\{([^}]+)\}/g, "{}");
      const args = op.pathParams
        .map((p) => `encode_path_segment(${safeIdent(p, "rs")})`)
        .join(", ");
      pathExpr = `format!(${JSON.stringify(fmtStr)}, ${args})`;
    }

    const bodyArg = op.hasBody
      ? op.bodyRequired
        ? "Some(body)"
        : "body"
      : "None";
    const queryArg = op.queryParams.length > 0 ? "query" : "&[]";
    const methodToken = `reqwest::Method::${op.method}`;
    const doc = sanitizeSingleLine(op.summary || op.operationId);

    if (op.isBinary) {
      return [
        `    /// ${doc}`,
        `    pub async fn ${fnName}(${params.join(", ")}) -> Result<(Vec<u8>, Option<String>), ApiError> {`,
        `        let path = ${pathExpr};`,
        `        self.send_bytes(${methodToken}, &path, ${bodyArg}, ${queryArg}).await`,
        `    }`,
      ].join("\n");
    }

    return [
      `    /// ${doc}`,
      `    pub async fn ${fnName}(${params.join(", ")}) -> Result<Value, ApiError> {`,
      `        let path = ${pathExpr};`,
      `        self.send_json(${methodToken}, &path, ${bodyArg}, ${queryArg}).await`,
      `    }`,
    ].join("\n");
  });

  return `// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.

use serde_json::Value;
use std::fmt;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub title: String,
    pub detail: String,
    pub request_id: String,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}: {}", self.status, self.code, self.detail)
    }
}

impl std::error::Error for ApiError {}

fn encode_path_segment(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

#[derive(Debug, Clone)]
pub struct GeneratedClient {
    base_url: String,
    api_key: Option<String>,
    http: reqwest::Client,
}

impl GeneratedClient {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self::with_http_client(base_url, api_key, http)
    }

    pub fn with_http_client(
        base_url: impl Into<String>,
        api_key: Option<String>,
        http: reqwest::Client,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key,
            http,
        }
    }

    async fn execute(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
        query: &[(&str, String)],
    ) -> Result<reqwest::Response, ApiError> {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.http.request(method, &url);
        if let Some(ref key) = self.api_key {
            req = req.bearer_auth(key);
        }
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(payload) = body {
            req = req.json(payload);
        }
        let resp = req.send().await.map_err(|err| ApiError {
            status: 0,
            code: "network_error".to_string(),
            title: "Network error".to_string(),
            detail: err.to_string(),
            request_id: String::new(),
        })?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            if let Ok(problem) = serde_json::from_str::<Value>(&text) {
                return Err(ApiError {
                    status,
                    code: problem
                        .get("code")
                        .and_then(|v| v.as_str())
                        .unwrap_or("api_error")
                        .to_string(),
                    title: problem
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("API Error")
                        .to_string(),
                    detail: problem
                        .get("detail")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&text)
                        .to_string(),
                    request_id: problem
                        .get("request_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                });
            }
            return Err(ApiError {
                status,
                code: "api_error".to_string(),
                title: "API Error".to_string(),
                detail: text,
                request_id: String::new(),
            });
        }

        Ok(resp)
    }

    async fn send_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
        query: &[(&str, String)],
    ) -> Result<Value, ApiError> {
        let resp = self.execute(method, path, body, query).await?;
        let status = resp.status().as_u16();
        if status == 204 || status == 205 {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        let text = resp.text().await.map_err(|err| ApiError {
            status: 0,
            code: "decode_error".to_string(),
            title: "Failed reading response".to_string(),
            detail: err.to_string(),
            request_id: String::new(),
        })?;
        if text.trim().is_empty() {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        serde_json::from_str::<Value>(&text).map_err(|err| ApiError {
            status: 0,
            code: "decode_error".to_string(),
            title: "Invalid JSON response".to_string(),
            detail: err.to_string(),
            request_id: String::new(),
        })
    }

    async fn send_bytes(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
        query: &[(&str, String)],
    ) -> Result<(Vec<u8>, Option<String>), ApiError> {
        let resp = self.execute(method, path, body, query).await?;
        let sha = resp
            .headers()
            .get("x-artifact-sha256")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let bytes = resp.bytes().await.map_err(|err| ApiError {
            status: 0,
            code: "decode_error".to_string(),
            title: "Failed reading binary response".to_string(),
            detail: err.to_string(),
            request_id: String::new(),
        })?;
        Ok((bytes.to_vec(), sha))
    }

${methods.join("\n\n")}
}
`;
};

export const generateAllTargets = async (specPath) => {
  const raw = await readFile(specPath, "utf8");
  const spec = YAML.parse(raw);
  const ops = extractOperations(spec);

  return {
    ops,
    files: {
      "sdks/typescript/src/generated/client.ts": generateTypeScript(spec, ops),
      "sdks/python/grad/_generated/__init__.py":
        "# AUTO-GENERATED by scripts/generate-sdks.mjs. DO NOT EDIT.\nfrom .client import AsyncGeneratedApiClient, GeneratedApiClient, GradApiError\n\n__all__ = ['AsyncGeneratedApiClient', 'GeneratedApiClient', 'GradApiError']\n",
      "sdks/python/grad/_generated/client.py": generatePython(spec, ops),
      "sdks/go/generated/client.go": generateGo(spec, ops),
      "sdks/rust/src/generated.rs": generateRust(spec, ops),
    },
  };
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
  void main();
}
