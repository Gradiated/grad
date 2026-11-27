/**
 * Python emitter: typed sync and natively async clients over the SDK's
 * transport (sdks/python/grad/_transport.py). Consumes the flat operation
 * list from ./ir.mjs plus the raw spec for schemas.
 */
import { toPascal, toSnake } from "./ir.mjs";

const sanitizeSingleLine = (text) =>
  String(text ?? "")
    .replace(/\r?\n+/g, " ")
    .trim();

const escapePyDocstring = (text) =>
  sanitizeSingleLine(text).replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');

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

