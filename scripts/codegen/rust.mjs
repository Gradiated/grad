/**
 * Rust emitter: `generated.rs` with serde models (forward-compatible string
 * enums) for the schemas the hand-written Rust SDK uses, plus page-size
 * maxima. The Rust SDK's transport and resources are hand-written, so no
 * client is generated.
 */
import { compareStrings, parameterMaxima, sanitizeSingleLine, schemaClosure, toPascal, toSnake } from "./ir.mjs";

/** The schemas the Rust SDK and CLI use; everything they reference is generated too. */
export const RUST_MODELS = [
  "ApiKey",
  "Artifact",
  "ArtifactDownloadUrl",
  "ArtifactImport",
  "ChatMessage",
  "Checkpoint",
  "CreateArtifactImportRequest",
  "CreateImportRequest",
  "Dataset",
  "DatasetRecordsPage",
  "EvalOutput",
  "EvalRun",
  "EvalTaskOutcome",
  "FilterDatasetRequest",
  "ImportJob",
  "MetricsPage",
  "PlanEvalRequest",
  "PlanEvalResponse",
  "PlanRunRequest",
  "PlanRunResponse",
  "PostEvalScoresRequest",
  "PostEvalScoresResponse",
  "RenderDatasetRequest",
  "RenderDatasetResponse",
  "Run",
  "RunCounts",
  "ScoreDatasetRequest",
  "TrainableModel",
  "UploadTicket",
  "UsageRecord",
  "UsageSummary",
];

/** Schemas whose property names the CLI checks user input against (`<Type>::FIELDS`). */
export const RUST_FIELD_LISTS = ["RecipeSpec"];

export const HEADER = "// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.\n";

const RS_KEYWORDS = new Set(
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while abstract become box do final macro override priv try typeof unsized virtual yield gen union".split(" "),
);
const RS_NO_RAW = new Set(["self", "Self", "super", "crate", "_"]);
const RS_RESERVED_TYPES = new Set(
  "Option Result Vec String Box Value Default Clone Debug Copy Send Sync Sized Drop Fn Iterator Error BTreeMap Serialize Deserialize".split(" "),
);

export const rsIdent = (raw) => {
  let ident = toSnake(raw);
  if (ident === "") ident = "field";
  if (/^[0-9]/.test(ident)) ident = `n${ident}`;
  if (RS_NO_RAW.has(ident)) return `${ident}_`;
  if (RS_KEYWORDS.has(ident)) return `r#${ident}`;
  return ident;
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

export const generateRustFile = async (fullIR, { roots = RUST_MODELS, fieldLists = RUST_FIELD_LISTS } = {}) => {
  const keep = schemaClosure(fullIR.schemas, roots);
  const ir = { ...fullIR, schemas: Object.fromEntries(Object.entries(fullIR.schemas).filter(([name]) => keep.has(name))) };
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

  /** Inline `T | null` array items and map values become `Option<T>`. */
  const element = (node, ctxName) => {
    const inner = typeOf(node, ctxName, undefined);
    return node.k === "nullable" && inner !== "Value" ? `Option<${inner}>` : inner;
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
        return `Vec<${element(node.items, `${ctxName}Item`)}>`;
      case "map":
        return `BTreeMap<String, ${element(node.values, `${ctxName}Value`)}>`;
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
    const docText = doc(node.description) || `/// Allowed values of \`${enumName}\`.\n`;
    const text = `string_enum! {\n${docText.replace(/^/gm, "    ").trimEnd()}\n    ${enumName} {\n${variants.map(({ v, value }) => `        ${v} => ${JSON.stringify(value)},`).join("\n")}\n    }\n}`;
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
      if (!prop.required) attrs.push('skip_serializing_if = "Option::is_none"');
      fields.push(`${doc(prop.type.description, "    ")}${attrs.length ? `    #[serde(${attrs.join(", ")})]\n` : ""}    pub ${ident}: ${ty},`);
    }
    if (node.additional !== undefined && node.additional !== false) {
      if (fieldNames.has("additional_properties")) throw new Error(`${structName} declares additional_properties; unsupported.`);
      fields.push("    /// Members not declared in the schema (round-tripped verbatim).\n    #[serde(flatten)]\n    pub additional_properties: BTreeMap<String, Value>,");
    }
    const head = isUnion
      ? `/// A union of object shapes: set the fields of exactly one variant.\n`
      : doc(node.description) || `/// Generated from the OpenAPI schema \`${structName}\`.\n`;
    const fieldList = fieldLists.includes(structName)
      ? `\n\nimpl ${structName} {\n    /// Every property name in the schema.\n    pub const FIELDS: &'static [&'static str] = &[${node.props.map((p) => JSON.stringify(p.name)).join(", ")}];\n}`
      : "";
    decls.push({
      name: structName,
      text: `${head}#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]\n#[serde(default)]\npub struct ${structName} {\n${fields.join("\n")}\n}${fieldList}`,
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

  const sorted = decls.sort((a, b) => compareStrings(a.name, b.name)).map((d) => d.text);
  const maxima = parameterMaxima(ir).map(
    (m) => `/// Largest \`${m.param}\` accepted by \`${rsIdent(m.op)}\` (the server clamps larger values).\npub const ${rsIdent(m.op).toUpperCase()}_${rsIdent(m.param).toUpperCase()}_MAX: u32 = ${m.maximum};`,
  );
  return `${HEADER}//! Request and response models of the schemas the SDK uses (see \`RUST_MODELS\` in scripts/codegen/rust.mjs).
//! Structs decode leniently (missing fields take their defaults) and string enums keep unknown values in \`Other\`.
#![allow(clippy::all, clippy::pedantic)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// A string enum that keeps values from newer servers in \`Other\` (default: the first variant).
macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $first:ident => $first_wire:literal $(, $variant:ident => $wire:literal)* $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
        pub enum $name {
            #[default]
            $first,
            $($variant,)*
            /// A value this SDK version does not know.
            Other(String),
        }

        impl $name {
            /// The wire value.
            pub fn as_str(&self) -> &str {
                match self {
                    Self::$first => $first_wire,
                    $(Self::$variant => $wire,)*
                    Self::Other(s) => s.as_str(),
                }
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                match s {
                    $first_wire => Self::$first,
                    $($wire => Self::$variant,)*
                    other => Self::Other(other.to_string()),
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                Ok(Self::from(String::deserialize(d)?.as_str()))
            }
        }
    };
}

${sorted.join("\n\n")}
${maxima.length ? `\n${maxima.join("\n")}\n` : ""}`;
};
