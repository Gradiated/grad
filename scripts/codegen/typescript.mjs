/**
 * TypeScript emitter: camelCase model types, a key codec table, and a typed
 * `ApiClient` with one method per operation (plus `<op>Stream` for SSE).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareStrings, sanitizeSingleLine, toCamel, toPascal } from "./ir.mjs";

const runtimeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime", "typescript");

export const HEADER = "// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.\n";

const TS_KEYWORDS = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with as implements interface let package private protected public static yield any boolean constructor declare get module require number set string symbol type from of async await undefined arguments eval never unknown object bigint"
  ).split(" "),
);

/** Names generated code itself uses as locals or imports. */
const RESERVED_LOCALS = new Set(["body", "params", "options", "path", "query", "headers", "signal", "transport", "spec", "url"]);

const RESERVED_TYPE_NAMES = new Set(
  (
    "Record Array Promise Date Error Map Set Object String Number Boolean Symbol Function Uint8Array ReadableStream Response Request Headers Blob URL AbortSignal Partial Required Readonly Pick Omit Exclude Extract NonNullable ReturnType Iterable AsyncIterable AsyncGenerator JSON Math Transport ApiClient RequestOptions StreamOptions SSEOptions RawResponse ServerSentEvent CodecNode CodecTable ResponseInfo GradError APIError TransportLike RequestSpec TransportOptions Sleep FieldError GradErrorInit APIErrorInit ErrorContext BadRequestError AuthenticationError PermissionDeniedError NotFoundError ConflictError ValidationError RateLimitError ServerError DeployUnavailableError InferenceUnavailableError APIConnectionError APITimeoutError APIUserAbortError RedirectError ResponseDecodeError CODEC"
  ).split(" "),
);

export const tsTypeName = (name) => {
  const ident = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : toPascal(name) || "Schema";
  const safe = /^[0-9]/.test(ident) ? `Schema${ident}` : ident;
  return RESERVED_TYPE_NAMES.has(safe) ? `${safe}Model` : safe;
};

export const tsParamIdent = (raw) => {
  let ident = toCamel(raw);
  if (ident === "") ident = "param";
  if (/^[0-9]/.test(ident)) ident = `p${ident}`;
  if (TS_KEYWORDS.has(ident) || RESERVED_LOCALS.has(ident)) ident = `${ident}Param`;
  return ident;
};

const propKey = (name) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name));

const comment = (text, indent = "") => {
  const line = sanitizeSingleLine(text).replace(/\*\//g, "*\\/");
  return line ? `${indent}/** ${line} */\n` : "";
};

const camelProps = (props, where) => {
  const seen = new Map();
  return props.map((prop) => {
    let camel = toCamel(prop.name);
    if (camel === "") camel = prop.name;
    if (seen.has(camel)) {
      throw new Error(`Properties '${seen.get(camel)}' and '${prop.name}' at ${where} both map to '${camel}' in TypeScript.`);
    }
    seen.set(camel, prop.name);
    return { ...prop, camel };
  });
};

const literal = (value) => JSON.stringify(value);

export const tsType = (node, names, where, indent = "") => {
  switch (node.k) {
    case "any":
      return "unknown";
    case "null":
      return "null";
    case "ref":
      return names.nullable?.has(node.name) ? `${names.get(node.name)} | null` : names.get(node.name);
    case "prim":
      if (node.t === "integer" || node.t === "number") return "number";
      if (node.t === "boolean") return "boolean";
      return "string";
    case "enum":
      return node.values.map(literal).join(" | ");
    case "nullable": {
      const inner = tsType(node.inner, names, where, indent);
      if (node.inner.k === "ref" && names.nullable?.has(node.inner.name)) return inner;
      return `${node.inner.k === "union" || node.inner.k === "enum" ? `(${inner})` : inner} | null`;
    }
    case "array": {
      const inner = tsType(node.items, names, `${where}[]`, indent);
      return `Array<${inner}>`;
    }
    case "map":
      return `Record<string, ${tsType(node.values, names, `${where}{}`, indent)}>`;
    case "union":
      return node.variants.map((v, i) => tsType(v, names, `${where}|${i}`, indent)).join(" | ");
    case "object": {
      if (node.props.length === 0) return node.additional === false ? "Record<string, never>" : "Record<string, unknown>";
      const inner = `${indent}  `;
      const lines = camelProps(node.props, where).map(
        (p) =>
          `${comment(p.type.description, inner)}${inner}${propKey(p.camel)}${p.required ? "" : "?"}: ${tsType(p.type, names, `${where}.${p.name}`, inner)}${p.required ? "" : " | undefined"};`,
      );
      if (node.additional !== undefined && node.additional !== false) lines.push(`${inner}[key: string]: unknown;`);
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
    default:
      throw new Error(`Unhandled type node '${node.k}' at ${where}.`);
  }
};

/** Codec descriptor for a node; `0` when no key ever needs renaming. */
const codecNode = (node, needs, where) => {
  switch (node.k) {
    case "ref":
      return needs.get(node.name) ? literal(node.name) : "0";
    case "nullable":
      return codecNode(node.inner, needs, where);
    case "array": {
      const inner = codecNode(node.items, needs, where);
      return inner === "0" ? "0" : `{ a: ${inner} }`;
    }
    case "map": {
      const inner = codecNode(node.values, needs, where);
      return inner === "0" ? "0" : `{ m: ${inner} }`;
    }
    case "union": {
      const arrays = node.variants.map(unwrap).filter((v) => v.k === "array");
      const objects = [];
      const refs = [];
      for (const v of node.variants.map(unwrap)) {
        if (v.k === "object") objects.push(v);
        if (v.k === "ref") refs.push(v);
      }
      const arrayPart = arrays.length > 0 ? codecNode(arrays[0], needs, where) : "0";
      let objectPart = "0";
      if (objects.length > 0 && refs.length === 0) {
        const merged = { k: "object", props: [] };
        const seen = new Set();
        for (const o of objects) {
          for (const p of o.props) {
            if (!seen.has(p.name)) {
              seen.add(p.name);
              merged.props.push(p);
            }
          }
        }
        objectPart = codecNode(merged, needs, where);
      } else if (refs.length === 1 && objects.length === 0) {
        objectPart = codecNode(refs[0], needs, where);
      } else if (refs.length > 0 || objects.length > 0) {
        const anyNeeds = refs.some((r) => needs.get(r.name)) || objects.some((o) => codecNode(o, needs, where) !== "0");
        if (anyNeeds) throw new Error(`Union at ${where} mixes object shapes whose keys need renaming; unsupported in TypeScript.`);
      }
      if (arrayPart === "0" && objectPart === "0") return "0";
      const parts = [];
      if (arrayPart !== "0") parts.push(`a: ${arrayPart}`);
      if (objectPart !== "0") parts.push(`o: ${objectPart}`);
      return `{ u: { ${parts.join(", ")} } }`;
    }
    case "object": {
      const props = camelProps(node.props, where);
      const fields = props.map((p) => [p.camel, p.name, codecNode(p.type, needs, `${where}.${p.name}`)]);
      const extra = node.additional && node.additional !== false ? codecNode(node.additional, needs, where) : "0";
      if (fields.every(([camel, wire, child]) => camel === wire && child === "0") && extra === "0") return "0";
      const list = fields
        .filter(([camel, wire, child]) => camel !== wire || child !== "0")
        .map(([camel, wire, child]) => `[${literal(camel)}, ${literal(wire)}, ${child}]`);
      return `{ o: [${list.join(", ")}]${extra !== "0" ? `, x: ${extra}` : ""} }`;
    }
    default:
      return "0";
  }
};

const unwrap = (node) => (node.k === "nullable" ? node.inner : node);

/** Fixed point: which named schemas contain keys that must be renamed. */
const computeNeeds = (schemas) => {
  const needs = new Map(Object.keys(schemas).map((n) => [n, false]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, node] of Object.entries(schemas)) {
      if (needs.get(name)) continue;
      if (codecNode(node, needs, name) !== "0") {
        needs.set(name, true);
        changed = true;
      }
    }
  }
  return needs;
};

const scalarTsType = (node, names) => {
  const base = unwrap(node);
  if (base.k === "array") return `Array<${scalarTsType(base.items, names)}>`;
  if (base.k === "any") return "string | number | boolean";
  return tsType(base, names, "param");
};

const methodName = (opId) => toCamel(opId);

export const generateTypeScriptFiles = async (ir, { sdkVersion = "0.0.0" } = {}) => {
  const names = new Map();
  const used = new Map();
  for (const name of Object.keys(ir.schemas)) {
    const tsName = tsTypeName(name);
    if (used.has(tsName)) throw new Error(`Schemas '${used.get(tsName)}' and '${name}' both map to TypeScript type '${tsName}'.`);
    used.set(tsName, name);
    names.set(name, tsName);
  }
  const needs = computeNeeds(ir.schemas);
  // A top-level nullable schema (`type: [object, "null"]`) is emitted without null; uses add `| null`.
  names.nullable = new Set(Object.entries(ir.schemas).filter(([, n]) => n.k === "nullable").map(([name]) => name));

  const modelBlocks = [];
  for (const [name, rawNode] of Object.entries(ir.schemas)) {
    const tsName = names.get(name);
    const node = rawNode.k === "nullable" ? { ...rawNode.inner, description: rawNode.description ?? rawNode.inner.description } : rawNode;
    const doc = comment(node.description);
    if (node.k === "object" && node.props.length > 0) {
      modelBlocks.push(`${doc}export interface ${tsName} ${tsType(node, names, name)}`);
    } else {
      modelBlocks.push(`${doc}export type ${tsName} = ${tsType(node, names, name)};`);
    }
    const base = unwrap(node);
    if (base.k === "enum") {
      modelBlocks.push(`export const ${tsName}Values = [${base.values.map(literal).join(", ")}] as const;`);
    }
  }

  const codecEntries = Object.entries(ir.schemas)
    .filter(([name]) => needs.get(name))
    .map(([name, node]) => `  ${literal(name)}: ${codecNode(node, needs, name)},`);

  const clientTypes = [];
  const methods = [];
  const usedTypeNames = new Set(names.values());
  const exportName = (candidate) => {
    if (usedTypeNames.has(candidate)) throw new Error(`Generated type name '${candidate}' collides with a schema name.`);
    usedTypeNames.add(candidate);
    return candidate;
  };

  for (const op of ir.operations) {
    const pascal = toPascal(op.id);
    const name = methodName(op.id);
    const args = [];
    const callArgs = [];
    const idents = new Set();
    const ident = (raw) => {
      let id = tsParamIdent(raw);
      while (idents.has(id)) id = `${id}_`;
      idents.add(id);
      return id;
    };

    const pathIdents = op.pathParams.map((p) => ({ p, id: ident(p.name) }));
    for (const { p, id } of pathIdents) {
      args.push(`${id}: ${scalarTsType(p.type, names) === "string" ? "string" : `${scalarTsType(p.type, names)} | string`}`);
      callArgs.push(id);
    }

    let bodyType;
    let bodyCodec = "0";
    if (op.body) {
      if (op.body.kind !== "json") throw new Error(`${op.id}: non-JSON request bodies are not supported by the TypeScript emitter.`);
      if (op.body.type.k === "ref") {
        bodyType = names.get(op.body.type.name);
      } else {
        bodyType = exportName(`${pascal}Request`);
        clientTypes.push(`export type ${bodyType} = ${tsType(op.body.type, names, `${op.id} body`)};`);
      }
      bodyCodec = codecNode(op.body.type, needs, `${op.id} body`);
      args.push(`body${op.body.required ? "" : "?"}: ${bodyType}`);
    }

    const allParams = [...op.queryParams, ...op.headerParams];
    let paramsType;
    let paramFields = [];
    if (allParams.length > 0) {
      paramsType = exportName(`${pascal}Params`);
      const seen = new Map();
      paramFields = allParams.map((p) => {
        let key = toCamel(p.name) || p.name;
        if (seen.has(key)) throw new Error(`${op.id}: parameters '${seen.get(key)}' and '${p.name}' both map to '${key}'.`);
        seen.set(key, p.name);
        return { ...p, key };
      });
      const lines = paramFields.map(
        (p) => `${comment(p.description, "  ")}  ${propKey(p.key)}${p.required ? "" : "?"}: ${scalarTsType(p.type, names)}${p.required ? "" : " | undefined"};`,
      );
      clientTypes.push(`export interface ${paramsType} {\n${lines.join("\n")}\n}`);
      const anyRequired = allParams.some((p) => p.required);
      args.push(`params${anyRequired ? "" : "?"}: ${paramsType}`);
    }

    const pathExpr =
      "`" +
      op.segments
        .map((seg, i) => {
          if (i % 2 === 0) return seg.replace(/[`\\$]/g, (c) => `\\${c}`);
          const match = pathIdents.find((x) => x.p.name === seg);
          return `\${encodePathParam(${match.id}, ${literal(seg)})}`;
        })
        .join("") +
      "`";

    const specParts = [`method: ${literal(op.method)}`, `path: ${pathExpr}`];
    const query = paramFields.filter((p) => p.in === "query");
    const headers = paramFields.filter((p) => p.in === "header");
    const access = (p) => `params${allParams.some((x) => x.required) ? "" : "?"}.${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.key) ? p.key : `[${literal(p.key)}]`}`;
    if (query.length > 0) specParts.push(`query: [${query.map((p) => `[${literal(p.name)}, ${access(p)}]`).join(", ")}]`);
    if (headers.length > 0) specParts.push(`headers: [${headers.map((p) => `[${literal(p.name)}, ${access(p)}]`).join(", ")}]`);
    if (op.body) specParts.push(`json: ${bodyCodec === "0" ? "body" : `convertKeys(CODEC, ${bodyCodec}, body, "encode")`}`);

    const docLines = [];
    const summary = sanitizeSingleLine(op.summary || op.id).replace(/\*\//g, "*\\/");
    docLines.push(`  /**\n   * ${summary}`);
    docLines.push(`   *\n   * \`${op.method} ${op.path.replace(/\*\//g, "*\\/")}\``);
    if (op.deprecated) docLines.push("   * @deprecated");
    docLines.push("   */");
    const doc = docLines.join("\n");

    const r = op.response;
    if (r.kind === "json") {
      let retType;
      if (r.type.k === "ref") retType = names.get(r.type.name);
      else {
        retType = exportName(`${pascal}Response`);
        clientTypes.push(`export type ${retType} = ${tsType(r.type, names, `${op.id} response`)};`);
      }
      const decode = codecNode(r.type, needs, `${op.id} response`);
      const sigArgs = [...args, "options?: RequestOptions"].join(", ");
      const result = decode === "0" ? "data" : `convertKeys(CODEC, ${decode}, data, "decode")`;
      methods.push(
        `${doc}\n  async ${name}(${sigArgs}): Promise<${retType}> {\n    const data = await this.transport.json({ ${specParts.join(", ")} }, options);\n    return ${result} as ${retType};\n  }`,
      );
    } else if (r.kind === "binary") {
      const sigArgs = [...args, "options?: StreamOptions"].join(", ");
      methods.push(
        `${doc}\n  ${name}(${sigArgs}): Promise<RawResponse> {\n    return this.transport.raw({ ${specParts.join(", ")}, accept: ${literal(r.contentType)} }, options);\n  }`,
      );
    } else if (r.kind === "empty") {
      const sigArgs = [...args, "options?: RequestOptions"].join(", ");
      methods.push(`${doc}\n  async ${name}(${sigArgs}): Promise<void> {\n    await this.transport.json({ ${specParts.join(", ")} }, options);\n  }`);
    }
    if (r.sse || r.kind === "sse-only") {
      const sigArgs = [...args, "options?: SSEOptions"].join(", ");
      const streamName = r.kind === "sse-only" ? name : `${name}Stream`;
      methods.push(
        `  /**\n   * ${summary} (Server-Sent Events; one connection, resume with \`lastEventId\`)\n   */\n  ${streamName}(${sigArgs}): AsyncGenerator<ServerSentEvent, void, undefined> {\n    return this.transport.sse({ ${specParts.join(", ")} }, options);\n  }`,
      );
    }
  }

  const methodText = methods.join("\n") + clientTypes.join("\n");
  const usedModels = [...names.values()].filter((n) => new RegExp(`\\b${n}\\b`).test(methodText)).sort(compareStrings);

  const models = `${HEADER}/* eslint-disable */\n\n${modelBlocks.join("\n\n")}\n`;

  const client = `${HEADER}/* eslint-disable */
import {
  convertKeys,
  encodePathParam,
  type CodecTable,
  type RawResponse,
  type RequestOptions,
  type ServerSentEvent,
  type SSEOptions,
  type StreamOptions,
  type TransportLike,
} from "./transport.js";
${usedModels.length > 0 ? `import type {\n${usedModels.map((n) => `  ${n},`).join("\n")}\n} from "./models.js";\n` : ""}
/** Which wire keys are renamed to camelCase, per schema (user-keyed maps are left verbatim). */
export const CODEC: CodecTable = {
${codecEntries.join("\n")}
};

${clientTypes.join("\n\n")}

/** Low-level client: one typed method per OpenAPI operation. */
export class ApiClient {
  constructor(readonly transport: TransportLike) {}

${methods.join("\n\n")}
}
`;

  const transportSrc = (await readFile(path.join(runtimeDir, "transport.ts"), "utf8")).replace("__SDK_VERSION__", sdkVersion);
  const index = `${HEADER}export * from "./transport.js";\nexport * from "./models.js";\nexport * from "./client.js";\n`;

  return {
    "models.ts": models,
    "client.ts": client.replace(/\n{3,}/g, "\n\n"),
    "transport.ts": `${HEADER}${transportSrc}`,
    "index.ts": index,
  };
};
