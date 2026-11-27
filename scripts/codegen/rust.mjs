/**
 * Rust emitter: one `generated.rs` with the transport runtime, `models`
 * (serde structs, forward-compatible string enums) and typed client methods.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareStrings, parameterMaxima, sanitizeSingleLine, toPascal, toSnake } from "./ir.mjs";

const runtimeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime", "rust");

export const HEADER = "// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.\n";

const RS_KEYWORDS = new Set(
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while abstract become box do final macro override priv try typeof unsized virtual yield gen union".split(" "),
);
const RS_NO_RAW = new Set(["self", "Self", "super", "crate", "_"]);
const RS_RESERVED_LOCALS = new Set(["body", "params", "path", "query", "headers", "last_event_id", "idempotency_key"]);
const RS_RESERVED_TYPES = new Set(
  "Option Result Vec String Box Value Default Clone Debug Copy Send Sync Sized Drop Fn Iterator Error ErrorKind ApiError FieldError GeneratedClient StreamResponse SseEvent SseStream QueryValue BTreeMap Serialize Deserialize".split(" "),
);

export const rsIdent = (raw) => {
  let ident = toSnake(raw);
  if (ident === "") ident = "field";
  if (/^[0-9]/.test(ident)) ident = `n${ident}`;
  if (RS_NO_RAW.has(ident)) return `${ident}_`;
  if (RS_KEYWORDS.has(ident)) return `r#${ident}`;
  return ident;
};

const rsParamIdent = (raw) => {
  const ident = rsIdent(raw);
  return RS_RESERVED_LOCALS.has(ident) ? `${ident}_param` : ident;
};

const rsTypeName = (name) => {
  let base = toPascal(name) || "Schema";
  if (/^[0-9]/.test(base)) base = `Schema${base}`;
  return RS_RESERVED_TYPES.has(base) ? `${base}Model` : base;
};

const doc = (text, indent = "") => {
  const line = sanitizeSingleLine(text);
  return line ? `${indent}/// ${line}\n` : "";
};

const unwrap = (node) => (node.k === "nullable" ? node.inner : node);

export const generateRustFile = async (ir, { sdkVersion = "0.0.0" } = {}) => {
  const names = new Map();
  const used = new Map();
  const claim = (name, owner) => {
    if (used.has(name)) throw new Error(`Rust type '${name}' is produced by both '${used.get(name)}' and '${owner}'.`);
    used.set(name, owner);
    return name;
  };
  for (const name of Object.keys(ir.schemas)) names.set(name, claim(rsTypeName(name), name));
  /** Inline types take the first free name: Ctx, CtxType, CtxType2, ... */
  const claimInline = (candidate) => {
    let name = candidate;
    for (let i = 1; used.has(name); i += 1) name = i === 1 ? `${candidate}Type` : `${candidate}Type${i}`;
    return claim(name, candidate);
  };
  const refTarget = (name) => unwrap(ir.schemas[name]);
  const isNullableSchema = (name) => ir.schemas[name].k === "nullable";

  const unionIsObjects = (node) =>
    node.variants.every((v) => {
      const u = unwrap(v);
      return (u.k === "object" && u.props.length > 0) || (u.k === "ref" && refTarget(u.name).k === "object" && refTarget(u.name).props.length > 0);
    });

  // Direct (non-collection) struct edges, to Box recursive fields.
  const directEdges = new Map();
  const directRefs = (node, acc = new Set()) => {
    const u = unwrap(node);
    if (u.k === "ref") acc.add(u.name);
    if (u.k === "object") for (const p of u.props) directRefs(p.type, acc);
    if (u.k === "union") for (const v of u.variants) directRefs(v, acc);
    return acc;
  };
  for (const [name, node] of Object.entries(ir.schemas)) directEdges.set(name, directRefs(node));
  const reaches = (from, to, seen = new Set()) => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const next of directEdges.get(from) ?? []) if (reaches(next, to, seen)) return true;
    return false;
  };

  const decls = [];

  /** A merged-union field stays required only when every variant requires it (e.g. a `kind` discriminator). */
  const requiredEverywhere = (node, propName) =>
    node.variants.every((v) => {
      const u = unwrap(v);
      const obj = u.k === "ref" ? refTarget(u.name) : u;
      return obj.props.some((q) => q.name === propName && q.required);
    });

  const mergeUnion = (node) => {
    const props = [];
    const seen = new Set();
    let additional;
    for (const v of node.variants) {
      const u = unwrap(v);
      const obj = u.k === "ref" ? refTarget(u.name) : u;
      for (const p of obj.props) {
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        const values = node.variants
          .map((x) => unwrap(x))
          .map((x) => (x.k === "ref" ? refTarget(x.name) : x))
          .flatMap((o) => o.props.filter((q) => q.name === p.name).map((q) => unwrap(q.type)))
          .filter((t) => t.k === "enum" && t.base === "string")
          .flatMap((t) => t.values);
        props.push({ ...p, type: values.length > 0 ? { k: "enum", base: "string", values: [...new Set(values)] } : p.type, required: requiredEverywhere(node, p.name) });
      }
      if (obj.additional) additional = obj.additional;
    }
    return { k: "object", props, ...(additional ? { additional } : {}) };
  };

  /** Rust type for a node (without Option). `owner` is the named schema containing it, for recursion. */
  const typeOf = (node, ctxName, owner) => {
    switch (node.k) {
      case "any":
      case "null":
        return "Value";
      case "nullable":
        return typeOf(node.inner, ctxName, owner);
      case "ref": {
        const t = names.get(node.name);
        return owner && reaches(node.name, owner) ? `Box<${t}>` : t;
      }
      case "prim":
        if (node.t === "integer") return "i64";
        if (node.t === "number") return "f64";
        if (node.t === "boolean") return "bool";
        return "String";
      case "enum":
        if (node.base !== "string") return node.base === "boolean" ? "bool" : node.base === "integer" ? "i64" : "f64";
        {
          const enumName = claimInline(ctxName);
          emitEnum(enumName, node);
          return enumName;
        }
      case "array":
        return `Vec<${typeOf(node.items, `${ctxName}Item`, undefined)}>`;
      case "map":
        return `BTreeMap<String, ${typeOf(node.values, `${ctxName}Value`, undefined)}>`;
      case "object":
        if (node.props.length === 0) return "BTreeMap<String, Value>";
        {
          const structName = claimInline(ctxName);
          emitStruct(structName, node, owner);
          return structName;
        }
      case "union":
        if (unionIsObjects(node)) {
          const structName = claimInline(ctxName);
          emitStruct(structName, mergeUnion(node), owner, true);
          return structName;
        }
        return "Value";
      default:
        throw new Error(`Unhandled node '${node.k}' for ${ctxName}.`);
    }
  };

  const emitEnum = (enumName, node) => {
    const variants = [];
    const seen = new Set();
    for (const value of node.values) {
      let v = toPascal(String(value)) || "Empty";
      if (/^[0-9]/.test(v)) v = `V${v}`;
      if (v === "Other") v = "OtherValue";
      while (seen.has(v)) v += "_";
      seen.add(v);
      variants.push({ v, value });
    }
    const first = variants[0].v;
    const text = `${doc(node.description) || `/// Allowed values of \`${enumName}\` (unknown values from newer servers are kept in \`Other\`).\n`}#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ${enumName} {
${variants.map(({ v, value }) => `    /// \`${JSON.stringify(value)}\`\n    ${v},`).join("\n")}
    /// A value this SDK version does not know.
    Other(String),
}

impl Default for ${enumName} {
    fn default() -> Self {
        Self::${first}
    }
}

impl ${enumName} {
    pub fn as_str(&self) -> &str {
        match self {
${variants.map(({ v, value }) => `            Self::${v} => ${JSON.stringify(value)},`).join("\n")}
            Self::Other(s) => s.as_str(),
        }
    }
}

impl From<&str> for ${enumName} {
    fn from(s: &str) -> Self {
        match s {
${variants.map(({ v, value }) => `            ${JSON.stringify(value)} => Self::${v},`).join("\n")}
            other => Self::Other(other.to_string()),
        }
    }
}

impl std::fmt::Display for ${enumName} {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for ${enumName} {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ${enumName} {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Ok(Self::from(s.as_str()))
    }
}`;
    decls.push({ name: enumName, text });
  };

  const emitStruct = (structName, node, owner, isUnion = false) => {
    const fields = [];
    const fieldNames = new Map();
    for (const prop of node.props) {
      const ident = rsIdent(prop.name);
      if (fieldNames.has(ident)) throw new Error(`Properties '${fieldNames.get(ident)}' and '${prop.name}' of ${structName} both map to Rust field '${ident}'.`);
      fieldNames.set(ident, prop.name);
      const inner = typeOf(prop.type, `${structName}${toPascal(prop.name)}`, owner ?? structName);
      const nullable = prop.type.k === "nullable" || (prop.type.k === "ref" && isNullableSchema(prop.type.name));
      const optional = !prop.required || nullable;
      const ty = optional ? `Option<${inner}>` : inner;
      const attrs = [];
      const bare = ident.startsWith("r#") ? ident.slice(2) : ident;
      if (bare !== prop.name) attrs.push(`rename = ${JSON.stringify(prop.name)}`);
      if (!prop.required) attrs.push('default, skip_serializing_if = "Option::is_none"');
      else if (nullable) attrs.push("default");
      fields.push(`${doc(prop.type.description, "    ")}${attrs.length ? `    #[serde(${attrs.join(", ")})]\n` : ""}    pub ${ident}: ${ty},`);
    }
    if (node.additional !== undefined && node.additional !== false) {
      if (fieldNames.has("additional_properties")) throw new Error(`${structName} declares additional_properties; unsupported.`);
      fields.push("    /// Members not declared in the schema (round-tripped verbatim).\n    #[serde(flatten)]\n    pub additional_properties: BTreeMap<String, Value>,");
    }
    const head = isUnion
      ? `/// A union of object shapes: set the fields of exactly one variant.\n`
      : doc(node.description) || `/// Generated from the OpenAPI schema \`${structName}\`.\n`;
    decls.push({
      name: structName,
      text: `${head}#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]\npub struct ${structName} {\n${fields.join("\n")}\n}`,
    });
  };

  for (const [name, node] of Object.entries(ir.schemas)) {
    const rsName = names.get(name);
    const base = unwrap(node);
    used.delete(rsName);
    used.set(rsName, name);
    if (base.k === "object" && base.props.length > 0) emitStruct(rsName, { ...base, description: node.description ?? base.description }, name);
    else if (base.k === "union" && unionIsObjects(base)) emitStruct(rsName, mergeUnion(base), name, true);
    else if (base.k === "enum" && base.base === "string") emitEnum(rsName, { ...base, description: node.description ?? base.description });
    else decls.push({ name: rsName, text: `${doc(node.description) || `/// Generated from the OpenAPI schema \`${name}\`.\n`}pub type ${rsName} = ${typeOf(base, `${rsName}Value`, undefined)};` });
  }

  const methods = [];
  for (const op of ir.operations) {
    const fnName = rsIdent(op.id);
    const pascal = toPascal(op.id);
    const args = ["&self"];
    const idents = new Set();
    const ident = (raw) => {
      let id = rsParamIdent(raw);
      while (idents.has(id)) id = `${id}_`;
      idents.add(id);
      return id;
    };
    const pathIdents = op.pathParams.map((p) => ({ p, id: ident(p.name) }));
    for (const { id } of pathIdents) args.push(`${id}: &str`);
    const pre = [];
    const fmtParts = [];
    const fmtArgs = [];
    op.segments.forEach((seg, i) => {
      if (i % 2 === 0) fmtParts.push(seg.replace(/[{}]/g, (c) => c + c));
      else {
        const match = pathIdents.find((x) => x.p.name === seg);
        fmtParts.push("{}");
        fmtArgs.push(`encode_path_segment(${JSON.stringify(seg)}, ${match.id})?`);
      }
    });
    pre.push(
      fmtArgs.length > 0
        ? `        let path = format!(${JSON.stringify(fmtParts.join(""))}, ${fmtArgs.join(", ")});`
        : `        let path = ${JSON.stringify(op.path)}.to_string();`,
    );

    let bodyExpr = "None::<&()>";
    if (op.body) {
      if (op.body.kind !== "json") throw new Error(`${op.id}: non-JSON request bodies are not supported by the Rust emitter.`);
      let bodyType = op.body.type.k === "ref" ? names.get(op.body.type.name) : typeOf(op.body.type, `${pascal}Request`, undefined);
      args.push(op.body.required ? `body: &${bodyType}` : `body: Option<&${bodyType}>`);
      bodyExpr = op.body.required ? "Some(body)" : "body";
    }

    const allParams = [...op.queryParams, ...op.headerParams];
    let queryExpr = "&[]";
    let headerExpr = "&[]";
    if (allParams.length > 0) {
      const paramsName = claimInline(`${pascal}Params`);
      const fields = [];
      const seen = new Map();
      const plan = allParams.map((p) => {
        const id = rsIdent(p.name);
        if (seen.has(id)) throw new Error(`${op.id}: parameters '${seen.get(id)}' and '${p.name}' both map to Rust field '${id}'.`);
        seen.set(id, p.name);
        const base = unwrap(p.type);
        const isArray = base.k === "array";
        const scalarNode = isArray ? unwrap(base.items) : base;
        let ty = scalarNode.k === "enum" || (scalarNode.k === "prim" && scalarNode.t === "string") || scalarNode.k === "any" ? "String" : typeOf(scalarNode, `${paramsName}${toPascal(p.name)}`, undefined);
        if (ty === "Value") ty = "String";
        const full = isArray ? `Vec<${ty}>` : p.required ? ty : `Option<${ty}>`;
        fields.push(`${doc(p.description, "    ")}    pub ${id}: ${full},`);
        return { p, id, isArray, required: p.required };
      });
      decls.push({
        name: paramsName,
        text: `/// Query and header parameters of \`${fnName}\`.\n#[derive(Debug, Clone, PartialEq, Default)]\npub struct ${paramsName} {\n${fields.join("\n")}\n}`,
      });
      const anyRequired = allParams.some((p) => p.required);
      args.push(anyRequired ? `params: &${paramsName}` : `params: Option<&${paramsName}>`);
      if (!anyRequired) pre.push(`        let default_params = ${paramsName}::default();\n        let params = params.unwrap_or(&default_params);`);
      const build = (location, varName) => {
        const items = plan.filter((x) => x.p.in === location);
        if (items.length === 0) return null;
        pre.push(`        let mut ${varName}: Vec<(&str, String)> = Vec::new();`);
        for (const item of items) {
          const key = JSON.stringify(item.p.name);
          if (item.isArray) pre.push(`        for v in &params.${item.id} {\n            ${varName}.push((${key}, v.query_value()));\n        }`);
          else if (item.required) pre.push(`        ${varName}.push((${key}, params.${item.id}.query_value()));`);
          else pre.push(`        if let Some(v) = &params.${item.id} {\n            ${varName}.push((${key}, v.query_value()));\n        }`);
        }
        return `&${varName}`;
      };
      queryExpr = build("query", "query") ?? "&[]";
      headerExpr = build("header", "headers") ?? "&[]";
    }

    if (op.idempotent) {
      // One key per call (reused by every retry); pass your own to retry a call across processes.
      args.push("idempotency_key: Option<&str>");
      const key = '("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))';
      if (headerExpr === "&[]") {
        pre.push(`        let headers: Vec<(&str, String)> = vec![${key}];`);
        headerExpr = "&headers";
      } else {
        pre.push(`        headers.push(${key});`);
      }
    }

    const summary = sanitizeSingleLine(op.summary || op.id);
    const header = `    /// ${summary}\n    ///\n    /// \`${op.method} ${op.path}\`\n`;
    const method = `reqwest::Method::${op.method}`;
    const r = op.response;
    if (r.kind === "json") {
      const ret = r.type.k === "ref" ? names.get(r.type.name) : typeOf(r.type, `${pascal}Response`, undefined);
      methods.push(
        `${header}    pub async fn ${fnName}(${args.join(", ")}) -> Result<${ret}, ApiError> {\n${pre.join("\n")}\n        self.request_json(${method}, &path, ${queryExpr}, ${headerExpr}, ${bodyExpr}).await\n    }`,
      );
    } else if (r.kind === "binary") {
      methods.push(
        `${header}    pub async fn ${fnName}(${args.join(", ")}) -> Result<StreamResponse, ApiError> {\n${pre.join("\n")}\n        self.request_stream(${method}, &path, ${queryExpr}, ${headerExpr}, ${bodyExpr}, ${JSON.stringify(r.contentType)}).await\n    }`,
      );
    } else if (r.kind === "empty") {
      methods.push(
        `${header}    pub async fn ${fnName}(${args.join(", ")}) -> Result<(), ApiError> {\n${pre.join("\n")}\n        let _: Value = self.request_json(${method}, &path, ${queryExpr}, ${headerExpr}, ${bodyExpr}).await?;\n        Ok(())\n    }`,
      );
    }
    if (r.sse || r.kind === "sse-only") {
      if (op.body) throw new Error(`${op.id}: SSE operations with a request body are unsupported in Rust.`);
      const streamName = r.kind === "sse-only" ? fnName : `${fnName}_stream`;
      const sseArgs = [...args, "last_event_id: Option<&str>"];
      methods.push(
        `    /// ${summary} (Server-Sent Events; resume with \`last_event_id\`)\n    pub async fn ${streamName}(${sseArgs.join(", ")}) -> Result<SseStream, ApiError> {\n${pre.join("\n")}\n        self.request_sse(${method}, &path, ${queryExpr}, last_event_id).await\n    }`,
      );
    }
  }

  const transport = (await readFile(path.join(runtimeDir, "transport.rs"), "utf8")).replace("__SDK_VERSION__", sdkVersion);
  const sorted = decls.sort((a, b) => compareStrings(a.name, b.name)).map((d) => d.text);
  const maxima = parameterMaxima(ir).map(
    (m) => `/// Largest \`${m.param}\` accepted by \`${rsIdent(m.op)}\` (the server clamps larger values).\npub const ${rsIdent(m.op).toUpperCase()}_${rsIdent(m.param).toUpperCase()}_MAX: u32 = ${m.maximum};`,
  );
  return `${HEADER}#![allow(clippy::all, clippy::pedantic, dead_code, unused_imports, non_camel_case_types)]

${transport}
/// Request and response models generated from \`components.schemas\`.
pub mod models {
    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use std::collections::BTreeMap;

${sorted.map((t) => t.replace(/^(?=.)/gm, "    ")).join("\n\n")}
}

pub use models::*;
${maxima.length ? `\n${maxima.join("\n")}\n` : ""}
impl GeneratedClient {
${methods.join("\n\n")}
}
`;
};
