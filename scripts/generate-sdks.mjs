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

// ---------------------------------------------------------------------------
// Python: typed operation wrappers over the hand-written runtime in grad/_transport.py.
// The generated module holds everything derived from the spec (TypedDicts for every
// schema, field/enum tables, and one sync + one async method per operation); retries,
// redirects, error mapping and the HTTP pools are hand-written and unit-tested.
// ---------------------------------------------------------------------------

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield", "match", "case", "type", "_",
]);
// Names the generated method bodies use for themselves.
const PY_RESERVED_LOCALS = new Set(["self", "body", "timeout", "query", "quote_path_param"]);

export const pyIdent = (raw) => {
  let base = toSnake(raw).replace(/[^A-Za-z0-9_]/g, "_");
  if (!base || /^[0-9]/.test(base)) base = `p_${base}`;
  if (PY_KEYWORDS.has(base) || PY_RESERVED_LOCALS.has(base)) base = `${base}_`;
  return base;
};

const pyString = (value) => JSON.stringify(String(value));

const pyLiteral = (value) => {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  return pyString(value);
};

const uniq = (items) => [...new Set(items)];

// Literal values inside a (string) type annotation use single quotes.
const pyTypeLiteral = (value) =>
  typeof value === "string" ? `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` : pyLiteral(value);

export const schemaToPyType = (schema) => {
  if (!schema || typeof schema !== "object") return "Any";
  if (schema.$ref) return schema.$ref.split("/").pop() ?? "Any";
  if (schema.const !== undefined) return `Literal[${pyTypeLiteral(schema.const)}]`;
  if (Array.isArray(schema.enum)) {
    const literals = schema.enum.filter((v) => v !== null).map(pyTypeLiteral);
    const parts = literals.length > 0 ? [`Literal[${literals.join(", ")}]`] : [];
    if (schema.enum.includes(null)) parts.push("None");
    return parts.join(" | ") || "Any";
  }
  if (Array.isArray(schema.allOf)) {
    const refs = schema.allOf.filter((s) => s && s.$ref);
    return refs.length === 1 ? schemaToPyType(refs[0]) : "dict[str, Any]";
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    return uniq(alternatives.map(schemaToPyType)).join(" | ");
  }
  if (Array.isArray(schema.type)) {
    return uniq(schema.type.map((t) => schemaToPyType({ ...schema, type: t }))).join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "null":
      return "None";
    case "array":
      return `list[${schemaToPyType(schema.items)}]`;
    case "object":
      if (schema.additionalProperties && typeof schema.additionalProperties === "object" && !schema.properties) {
        return `dict[str, ${schemaToPyType(schema.additionalProperties)}]`;
      }
      return "dict[str, Any]";
    default:
      return "Any";
  }
};

const isObjectSchema = (schema) =>
  Boolean(schema && typeof schema === "object" && schema.properties && Object.keys(schema.properties).length > 0);

const pyTypedDict = (name, schema) => {
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties).map(([key, value]) => {
    const type = schemaToPyType(value);
    return `        ${pyString(key)}: ${pyString(required.has(key) ? type : `NotRequired[${type}]`)},`;
  });
  return `${name} = TypedDict(\n    ${pyString(name)},\n    {\n${fields.join("\n")}\n    },\n)`;
};

const operationOf = (spec, op) => spec.paths?.[op.path]?.[op.method.toLowerCase()] ?? {};

const pySuccess = (spec, op) => {
  const operation = operationOf(spec, op);
  const entry = Object.entries(operation.responses ?? {}).find(([code]) => code.startsWith("2"));
  const content = entry?.[1]?.content ?? {};
  const types = Object.keys(content);
  const json = content["application/json"]?.schema;
  return {
    json,
    stream: types.find((t) => t !== "application/json" && t !== "text/event-stream") ?? null,
    sse: types.includes("text/event-stream"),
  };
};

const pyResponseName = (op) => `${toPascal(op.operationId).replace(/ID$/, "Id")}Response`;

const pyQueryParams = (spec, op) => {
  const operation = operationOf(spec, op);
  const shared = spec.paths?.[op.path]?.parameters ?? [];
  const byName = new Map();
  for (const p of [...shared, ...(operation.parameters ?? [])]) {
    if (p && p.in === "query") byName.set(p.name, p);
  }
  return [...byName.values()].map((p) => ({
    name: p.name,
    ident: pyIdent(p.name),
    type: schemaToPyType(p.schema),
    required: Boolean(p.required),
  }));
};

const pyPathParams = (op) => (op.path.match(/\{([^}]+)\}/g) ?? []).map((m) => m.slice(1, -1));

const pyMethod = (spec, op, { isAsync, inlineTypes }) => {
  const name = toSnake(op.operationId);
  const success = pySuccess(spec, op);
  const pathParams = pyPathParams(op);
  const query = pyQueryParams(spec, op);
  const operation = operationOf(spec, op);
  const bodyRef = operation.requestBody?.content?.["application/json"]?.schema;
  const bodyType = bodyRef?.$ref ? `${schemaToPyType(bodyRef)} | Mapping[str, Any]` : "Mapping[str, Any]";

  const sig = ["self"];
  for (const p of pathParams) sig.push(`${pyIdent(p)}: str`);
  if (op.hasBody) sig.push(op.bodyRequired ? `body: ${bodyType}` : `body: ${bodyType} | None = None`);
  sig.push("*");
  for (const q of query) sig.push(`${q.ident}: ${q.type.includes("None") ? q.type : `${q.type} | None`} = None`);
  sig.push("timeout: float | None = None");

  const pathExpr = pathParams.length
    ? `f${pyString(op.path.replace(/\{([^}]+)\}/g, (_, p) => `{quote_path_param(${pyIdent(p)}, ${JSON.stringify(p).replace(/"/g, "'")})}`))}`
    : pyString(op.path);
  const queryArg = query.length ? `query={${query.map((q) => `${pyString(q.name)}: ${q.ident}`).join(", ")}}, ` : "";
  const bodyArg = op.hasBody ? "json_body=body, " : "";
  const doc = escapePyDocstring(op.summary || op.operationId);
  const def = isAsync ? "async def" : "def";
  const awaitKw = isAsync ? "await " : "";
  const methods = [];

  if (success.stream && !success.json) {
    const ret = isAsync ? "AsyncResponse" : "Response";
    methods.push(
      [
        `    ${def} ${name}(${sig.join(", ")}) -> ${ret}:`,
        `        """${doc} (streams \`${success.stream}\`; read or close the response)."""`,
        `        return ${awaitKw}self._t.stream(${pyString(op.method)}, ${pathExpr}, ${queryArg}accept=${pyString(success.stream)}, timeout=timeout)`,
      ].join("\n"),
    );
    return methods;
  }

  let ret = "Any";
  if (success.json?.$ref) ret = schemaToPyType(success.json);
  else if (isObjectSchema(success.json)) {
    ret = pyResponseName(op);
    inlineTypes.push(pyTypedDict(ret, success.json));
  } else if (success.json) ret = schemaToPyType(success.json);

  methods.push(
    [
      `    ${def} ${name}(${sig.join(", ")}) -> ${ret}:`,
      `        """${doc}."""`,
      ret === "Any"
        ? `        return ${awaitKw}self._t.request(${pyString(op.method)}, ${pathExpr}, ${queryArg}${bodyArg}timeout=timeout)`
        : `        return cast(${pyString(ret)}, ${awaitKw}self._t.request(${pyString(op.method)}, ${pathExpr}, ${queryArg}${bodyArg}timeout=timeout))`,
    ].join("\n"),
  );
  if (success.sse) {
    const streamRet = isAsync ? "AsyncResponse" : "Response";
    methods.push(
      [
        `    ${def} ${name}_stream(${sig.join(", ")}) -> ${streamRet}:`,
        `        """${doc} (Server-Sent Events stream; read or close the response)."""`,
        `        return ${awaitKw}self._t.stream(${pyString(op.method)}, ${pathExpr}, ${queryArg}accept="text/event-stream", timeout=timeout)`,
      ].join("\n"),
    );
  }
  return methods;
};

export const generatePython = (spec, ops) => {
  const schemas = spec.components?.schemas ?? {};
  const names = Object.keys(schemas).sort();
  const blocks = [];
  const fieldTable = [];
  const enumTable = [];
  for (const name of names) {
    const schema = schemas[name];
    if (isObjectSchema(schema)) {
      blocks.push(pyTypedDict(name, schema));
      fieldTable.push(`    ${pyString(name)}: frozenset({${Object.keys(schema.properties).sort().map(pyString).join(", ")}}),`);
    } else {
      blocks.push(`${name}: TypeAlias = ${pyString(schemaToPyType(schema))}`);
    }
    if (Array.isArray(schema.enum)) {
      enumTable.push(`    ${pyString(name)}: (${schema.enum.map(pyLiteral).join(", ")},),`);
    }
  }

  const syncInline = [];
  const asyncInline = [];
  const syncMethods = ops.flatMap((op) => pyMethod(spec, op, { isAsync: false, inlineTypes: syncInline }));
  const asyncMethods = ops.flatMap((op) => pyMethod(spec, op, { isAsync: true, inlineTypes: asyncInline }));
  const operations = ops.map((op) => `    ${pyString(toSnake(op.operationId))}: (${pyString(op.method)}, ${pyString(op.path)}),`);

  return `# AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.
"""Generated wire layer for the Gradiated Training & Serving API.

One method per OpenAPI operation, typed with a \`\`TypedDict\`\` per schema. The
request policy (auth, retries, redirects, typed errors) lives in \`\`grad._transport\`\`.
Prefer the resource objects on \`\`grad.Grad\`\`; this layer is the escape hatch
(\`\`client.wire\`\`) for anything the façade does not wrap.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal, Mapping, NotRequired, TypeAlias, TypedDict, cast

from .._errors import GradAPIError as GradApiError
from .._transport import quote_path_param

if TYPE_CHECKING:
    from .._http import AsyncResponse, Response
    from .._transport import AsyncTransport, SyncTransport

__all__ = ["AsyncGeneratedApiClient", "GeneratedApiClient", "GradApiError", "OPERATIONS", "SCHEMA_ENUMS", "SCHEMA_FIELDS"]

${blocks.join("\n\n")}

${syncInline.join("\n\n")}

SCHEMA_FIELDS: dict[str, frozenset[str]] = {
${fieldTable.join("\n")}
}
"""Property names of every object schema (for client-side typo checks)."""

SCHEMA_ENUMS: dict[str, tuple[Any, ...]] = {
${enumTable.join("\n")}
}
"""Allowed values of every enum schema."""

OPERATIONS: dict[str, tuple[str, str]] = {
${operations.join("\n")}
}
"""operationId (snake_case) -> (HTTP method, path template)."""


class GeneratedApiClient:
    """Blocking wire client: one method per operation in spec/openapi.yaml."""

    def __init__(self, transport: SyncTransport) -> None:
        self._t = transport

${syncMethods.join("\n\n")}


class AsyncGeneratedApiClient:
    """asyncio wire client: one coroutine per operation in spec/openapi.yaml."""

    def __init__(self, transport: AsyncTransport) -> None:
        self._t = transport

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
