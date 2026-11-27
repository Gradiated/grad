/**
 * Go emitter: structs with json tags (pointers for optional scalars), string
 * enum types with constants, and a typed `Client` with one method per
 * operation. Output is gofmt-clean (the codegen tests run gofmt -l on it).
 * The HTTP runtime (sdks/go/generated/transport.go) is hand-written.
 */
import { compareStrings, parameterMaxima, sanitizeSingleLine, toPascal, toSnake } from "./ir.mjs";


export const HEADER = "// Code generated from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.\n";

const INITIALISMS = new Map(
  [
    "api", "id", "ids", "url", "uri", "usd", "hf", "json", "http", "https", "sha256", "sse", "ttl", "kl", "lr", "ip", "ui", "uuid", "ndjson", "sql", "tls", "cpu", "gpu", "ci", "html", "xml", "jwt", "otel",
  ].map((w) => [w, w === "ids" ? "IDs" : w.toUpperCase()]),
);

const GO_KEYWORDS = new Set(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var".split(" "),
);
/** Predeclared identifiers and names the generated code uses as locals. */
const GO_RESERVED_LOCALS = new Set(
  "any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr true false iota nil append cap clear close complex copy delete imag len make max min new panic print println real recover ctx c body params opts out err q h path url fmt http json context strconv time spec".split(" "),
);
const GO_RESERVED_TYPES = new Set(
  "Client Transport Config RequestSpec RequestOption ResponseInfo GradError APIError FieldError BadRequestError AuthenticationError PermissionDeniedError NotFoundError ConflictError ValidationError RateLimitError ServerError DeployUnavailableError InferenceUnavailableError ConnectionError TimeoutError RedirectError DecodeError StreamResponse SSEEvent SSEStream NewClient NewTransport Ptr".split(" "),
);

/** Pascal-cases with Go initialisms: run_id -> RunID, max_cost_usd -> MaxCostUSD, hf_repo -> HFRepo. */
export const goName = (raw, { allowLeadingDigit = false } = {}) => {
  const words = toSnake(raw).split("_").filter(Boolean);
  if (words.length === 0) return "X";
  const out = words
    .map((w) => INITIALISMS.get(w) ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return /^[0-9]/.test(out) && !allowLeadingDigit ? `X${out}` : out;
};

const goTypeName = (name) => {
  const base = goName(name);
  return GO_RESERVED_TYPES.has(base) ? `${base}Model` : base;
};

export const goParamIdent = (raw) => {
  const pascal = goName(raw);
  let ident = pascal.charAt(0).toLowerCase() + pascal.slice(1);
  const lead = /^[A-Z]{2,}/.exec(pascal);
  if (lead) {
    // RunID -> runID, URL -> url, IDs -> ids
    const run = lead[0];
    const n = run.length === pascal.length || /[a-z]/.test(pascal.charAt(run.length)) === false ? run.length : run.length - 1;
    ident = pascal.slice(0, n).toLowerCase() + pascal.slice(n);
  }
  if (GO_KEYWORDS.has(ident) || GO_RESERVED_LOCALS.has(ident)) ident = `${ident}Param`;
  return ident;
};

/** Mimics gofmt's tabwriter alignment for a block of rows (cells separated into columns). */
const alignRows = (rows, indent) => {
  // rows: Array<string | string[]>; strings (comments/blank) break alignment sections.
  const out = [];
  let section = [];
  const flush = () => {
    if (section.length === 0) return;
    const widths = [];
    for (const cells of section) {
      cells.forEach((cell, i) => {
        if (i < cells.length - 1) widths[i] = Math.max(widths[i] ?? 0, cell.length);
      });
    }
    for (const cells of section) {
      out.push(
        indent +
          cells
            .map((cell, i) => (i < cells.length - 1 ? cell.padEnd(widths[i] + 1) : cell))
            .join("")
            .replace(/\s+$/, ""),
      );
    }
    section = [];
  };
  for (const row of rows) {
    if (typeof row === "string") {
      flush();
      out.push(row === "" ? "" : indent + row);
    } else {
      section.push(row);
    }
  }
  flush();
  return out.join("\n");
};

const unwrap = (node) => (node.k === "nullable" ? node.inner : node);

export const generateGoFiles = async (ir) => {
  const names = new Map();
  const usedNames = new Map();
  const claim = (goTypeIdent, owner) => {
    if (usedNames.has(goTypeIdent)) {
      throw new Error(`Go type name '${goTypeIdent}' is produced by both '${usedNames.get(goTypeIdent)}' and '${owner}'.`);
    }
    usedNames.set(goTypeIdent, owner);
    return goTypeIdent;
  };
  for (const name of Object.keys(ir.schemas)) names.set(name, claim(goTypeName(name), name));
  /** Inline types take the first free name: Ctx, CtxType, CtxType2, ... */
  const claimInline = (candidate) => {
    let name = candidate;
    for (let i = 1; usedNames.has(name); i += 1) name = i === 1 ? `${candidate}Type` : `${candidate}Type${i}`;
    return claim(name, candidate);
  };

  const isNullableSchema = (name) => ir.schemas[name].k === "nullable";
  /** What a ref resolves to, without the nullable wrapper. */
  const refTarget = (name) => unwrap(ir.schemas[name]);

  const decls = [];
  const enumDecls = [];

  /**
   * Returns the Go type for a node. `ctxName` names inline structs/enums.
   * Result: { type, kind } where kind is "struct" | "scalar" | "ref-struct" | "slice" | "map" | "any" | "enum".
   */
  const typeOf = (node, ctxName) => {
    switch (node.k) {
      case "any":
      case "null":
        return { type: "any", kind: "any" };
      case "nullable":
        return typeOf(node.inner, ctxName);
      case "ref": {
        const target = refTarget(node.name);
        const goT = names.get(node.name);
        if (target.k === "object" || (target.k === "union" && unionIsObjects(target))) return { type: goT, kind: "struct" };
        if (target.k === "array") return { type: goT, kind: "slice" };
        if (target.k === "map") return { type: goT, kind: "map" };
        if (target.k === "enum") return { type: goT, kind: "scalar" };
        if (target.k === "prim") return { type: goT, kind: "scalar" };
        return { type: goT, kind: "any" };
      }
      case "prim":
        if (node.t === "integer") return { type: "int", kind: "scalar" };
        if (node.t === "number") return { type: "float64", kind: "scalar" };
        if (node.t === "boolean") return { type: "bool", kind: "scalar" };
        return { type: "string", kind: "scalar" };
      case "enum": {
        if (node.base !== "string") return { type: node.base === "boolean" ? "bool" : node.base === "integer" ? "int" : "float64", kind: "scalar" };
        const enumName = claimInline(ctxName);
        emitEnum(enumName, node);
        return { type: enumName, kind: "scalar" };
      }
      case "array": {
        const inner = typeOf(node.items, `${ctxName}Item`);
        const elem = node.items.k === "nullable" && (inner.kind === "scalar" || inner.kind === "struct") ? `*${inner.type}` : inner.type;
        return { type: `[]${elem}`, kind: "slice" };
      }
      case "map": {
        const inner = typeOf(node.values, `${ctxName}Value`);
        const elem = node.values.k === "nullable" && (inner.kind === "scalar" || inner.kind === "struct") ? `*${inner.type}` : inner.type;
        return { type: `map[string]${elem}`, kind: "map" };
      }
      case "object": {
        if (node.props.length === 0) return { type: "map[string]any", kind: "map" };
        const structName = claimInline(ctxName);
        emitStruct(structName, node);
        return { type: structName, kind: "struct" };
      }
      case "union": {
        if (unionIsObjects(node)) {
          const structName = claimInline(ctxName);
          emitStruct(structName, mergeUnion(node), true);
          return { type: structName, kind: "struct" };
        }
        return { type: "any", kind: "any" };
      }
      default:
        throw new Error(`Unhandled node '${node.k}' for ${ctxName}.`);
    }
  };

  const unionIsObjects = (node) =>
    node.variants.every((v) => {
      const u = unwrap(v);
      return (u.k === "object" && u.props.length > 0) || (u.k === "ref" && refTarget(u.name).k === "object");
    });

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
        // In a merged union every field is optional; discriminators keep their union of values.
        const allValues = node.variants
          .map((x) => unwrap(x))
          .map((x) => (x.k === "ref" ? refTarget(x.name) : x))
          .flatMap((o) => o.props.filter((q) => q.name === p.name).map((q) => unwrap(q.type)))
          .filter((t) => t.k === "enum" && t.base === "string")
          .flatMap((t) => t.values);
        const type = allValues.length > 0 ? { k: "enum", base: "string", values: [...new Set(allValues)] } : p.type;
        props.push({ ...p, type, required: requiredEverywhere(node, p.name) });
      }
      if (obj.additional) additional = obj.additional;
    }
    return { k: "object", props, ...(additional ? { additional } : {}) };
  };

  const fieldGoType = (prop, structName) => {
    const fieldName = goName(prop.name);
    const t = typeOf(prop.type, `${structName}${fieldName}`);
    const nullable = prop.type.k === "nullable" || (prop.type.k === "ref" && isNullableSchema(prop.type.name));
    const pointer = (t.kind === "scalar" || t.kind === "struct") && (!prop.required || nullable);
    return { fieldName, type: pointer ? `*${t.type}` : t.type, omit: !prop.required };
  };

  const emitEnum = (enumName, node) => {
    const doc = node.description ? `// ${enumName} ${sanitizeSingleLine(node.description)}\n` : `// ${enumName} is an enumeration of allowed values.\n`;
    const rows = [];
    const seen = new Set();
    for (const value of node.values) {
      let constName = `${enumName}${goName(String(value), { allowLeadingDigit: true }) || "Empty"}`;
      while (seen.has(constName)) constName += "_";
      seen.add(constName);
      rows.push([constName, enumName, `= ${JSON.stringify(value)}`]);
    }
    enumDecls.push({
      name: enumName,
      text: `${doc}type ${enumName} string\n\n// Values of ${enumName}.\nconst (\n${alignRows(rows, "\t")}\n)`,
    });
  };

  const emitStruct = (structName, node, isUnion = false) => {
    const rows = [];
    const fieldNames = new Map();
    const known = [];
    const lines = [];
    const fields = node.props.map((prop) => {
      const f = fieldGoType(prop, structName);
      if (fieldNames.has(f.fieldName)) {
        throw new Error(`Properties '${fieldNames.get(f.fieldName)}' and '${prop.name}' of ${structName} both map to Go field '${f.fieldName}'.`);
      }
      fieldNames.set(f.fieldName, prop.name);
      known.push(prop.name);
      return { prop, ...f };
    });
    const hasExtra = node.additional !== undefined && node.additional !== false;
    if (hasExtra && fieldNames.has("AdditionalProperties")) {
      throw new Error(`${structName} has a property named AdditionalProperties; unsupported.`);
    }
    for (const f of fields) {
      const desc = sanitizeSingleLine(f.prop.type.description ?? "");
      if (desc) rows.push(`// ${f.fieldName} ${desc}`);
      rows.push([f.fieldName, f.type, `\`json:"${f.prop.name}${f.omit ? ",omitempty" : ""}"\``]);
    }
    if (hasExtra) {
      rows.push("// AdditionalProperties holds members not declared in the schema (round-tripped verbatim).");
      rows.push(["AdditionalProperties", "map[string]any", '`json:"-"`']);
    }
    const doc = isUnion
      ? `// ${structName} is a union of object shapes; set the fields of exactly one variant.\n`
      : node.description
        ? `// ${structName} ${sanitizeSingleLine(node.description)}\n`
        : `// ${structName} is generated from the OpenAPI schema.\n`;
    lines.push(`${doc}type ${structName} struct {\n${alignRows(rows, "\t")}\n}`);
    if (hasExtra) {
      const knownVar = `known${structName}Fields`;
      const knownRows = known.map((k) => [`${JSON.stringify(k)}:`, "true,"]);
      lines.push(
        `var ${knownVar} = map[string]bool{\n${alignRows(knownRows, "\t")}\n}`,
        `// MarshalJSON encodes declared fields plus AdditionalProperties.\nfunc (m ${structName}) MarshalJSON() ([]byte, error) {\n\ttype plain ${structName}\n\treturn MarshalWithAdditional(plain(m), m.AdditionalProperties)\n}`,
        `// UnmarshalJSON decodes declared fields and keeps the rest in AdditionalProperties.\nfunc (m *${structName}) UnmarshalJSON(data []byte) error {\n\ttype plain ${structName}\n\tvar p plain\n\tif err := json.Unmarshal(data, &p); err != nil {\n\t\treturn err\n\t}\n\textra, err := AdditionalFields(data, ${knownVar})\n\tif err != nil {\n\t\treturn err\n\t}\n\t*m = ${structName}(p)\n\tm.AdditionalProperties = extra\n\treturn nil\n}`,
      );
    }
    decls.push({ name: structName, text: lines.join("\n\n") });
  };

  // Named schemas.
  for (const [name, node] of Object.entries(ir.schemas)) {
    const goT = names.get(name);
    const base = unwrap(node);
    usedNames.delete(goT);
    if (base.k === "object" && base.props.length > 0) {
      usedNames.set(goT, name);
      emitStruct(goT, { ...base, description: node.description ?? base.description });
    } else if (base.k === "union" && unionIsObjects(base)) {
      usedNames.set(goT, name);
      emitStruct(goT, mergeUnion(base), true);
    } else if (base.k === "enum" && base.base === "string") {
      usedNames.set(goT, name);
      emitEnum(goT, { ...base, description: node.description ?? base.description });
    } else {
      usedNames.set(goT, name);
      const t = typeOf(base, `${goT}Value`);
      const doc = node.description ? `// ${goT} ${sanitizeSingleLine(node.description)}\n` : `// ${goT} is generated from the OpenAPI schema.\n`;
      decls.push({ name: goT, text: `${doc}type ${goT} ${t.kind === "any" ? "= any" : t.type}` });
    }
  }

  // Operations.
  const methods = [];
  for (const op of ir.operations) {
    const methodName = goName(op.id);
    const pascal = methodName;
    const args = ["ctx context.Context"];
    const idents = new Set();
    const ident = (raw) => {
      let id = goParamIdent(raw);
      while (idents.has(id)) id = `${id}_`;
      idents.add(id);
      return id;
    };
    const pre = [];
    const pathIdents = op.pathParams.map((p) => {
      const id = ident(p.name);
      const base = unwrap(p.type);
      const isInt = base.k === "prim" && base.t === "integer";
      args.push(`${id} ${isInt ? "int" : "string"}`);
      return { p, id, isInt };
    });
    pathIdents.forEach(({ p, id, isInt }, i) => {
      pre.push(`\tp${i}, err := EscapePathParam(${JSON.stringify(p.name)}, ${isInt ? `strconv.Itoa(${id})` : id})`);
      pre.push("\tif err != nil {");
      pre.push(`\t\treturn ${"%RET_ERR%"}`);
      pre.push("\t}");
    });
    const pathExpr =
      op.segments
        .map((seg, i) => {
          if (i % 2 === 0) return seg === "" ? null : JSON.stringify(seg);
          return `p${pathIdents.findIndex((x) => x.p.name === seg)}`;
        })
        .filter((x) => x !== null)
        .join(" + ") || '""';

    let bodyArg = "";
    if (op.body) {
      if (op.body.kind !== "json") throw new Error(`${op.id}: non-JSON request bodies are not supported by the Go emitter.`);
      let bodyType;
      if (op.body.type.k === "ref") bodyType = names.get(op.body.type.name);
      else {
        const t = typeOf(op.body.type, `${pascal}Request`);
        bodyType = t.type;
      }
      const t = op.body.type.k === "ref" ? typeOf(op.body.type, "") : { kind: "struct" };
      const ptr = t.kind === "struct" ? `*${bodyType}` : bodyType;
      args.push(`body ${ptr}`);
      if (op.body.required) {
        pre.push("\tif body == nil {");
        pre.push(`\t\treturn ${"%RET_ERR_BODY%"}`);
        pre.push("\t}");
      }
      bodyArg = "body";
    }

    const allParams = [...op.queryParams, ...op.headerParams];
    if (allParams.length > 0) {
      const paramsName = claimInline(`${pascal}Params`);
      const rows = [];
      const fieldNames = new Map();
      const fields = allParams.map((p) => {
        const fieldName = goName(p.name);
        if (fieldNames.has(fieldName)) throw new Error(`${op.id}: parameters '${fieldNames.get(fieldName)}' and '${p.name}' both map to Go field '${fieldName}'.`);
        fieldNames.set(fieldName, p.name);
        const base = unwrap(p.type);
        let elem;
        if (base.k === "array") {
          const inner = unwrap(base.items);
          elem = { type: `[]${typeOf(inner, `${paramsName}${fieldName}Item`).type}`, slice: true };
        } else {
          elem = { type: typeOf(base, `${paramsName}${fieldName}`).type, slice: false };
        }
        const pointer = !elem.slice && !p.required;
        return { p, fieldName, type: pointer ? `*${elem.type}` : elem.type, pointer, slice: elem.slice };
      });
      for (const f of fields) {
        const desc = sanitizeSingleLine(f.p.description ?? "");
        if (desc) rows.push(`// ${f.fieldName} ${desc}`);
        rows.push([f.fieldName, f.type]);
      }
      decls.push({
        name: paramsName,
        text: `// ${paramsName} holds the query and header parameters of ${methodName}.\ntype ${paramsName} struct {\n${alignRows(rows, "\t")}\n}`,
      });
      const required = allParams.some((p) => p.required);
      args.push(`params ${required ? "" : "*"}${paramsName}`);
      const q = fields.filter((f) => f.p.in === "query");
      const h = fields.filter((f) => f.p.in === "header");
      const guard = required ? "" : "if params != nil {";
      const ind = required ? "\t" : "\t\t";
      if (q.length > 0) pre.push("\tq := url.Values{}");
      if (h.length > 0) pre.push("\th := http.Header{}");
      if (guard) pre.push(`\t${guard}`);
      for (const f of fields) {
        const target = f.p.in === "query" ? "q" : "h";
        const add = (v) => `${target}.Add(${JSON.stringify(f.p.name)}, FormatScalar(${v}))`;
        if (f.slice) {
          pre.push(`${ind}for _, v := range params.${f.fieldName} {`);
          pre.push(`${ind}\t${add("v")}`);
          pre.push(`${ind}}`);
        } else if (f.pointer) {
          pre.push(`${ind}if params.${f.fieldName} != nil {`);
          pre.push(`${ind}\t${add(`*params.${f.fieldName}`)}`);
          pre.push(`${ind}}`);
        } else {
          pre.push(`${ind}${add(`params.${f.fieldName}`)}`);
        }
      }
      if (guard) pre.push("\t}");
    }
    args.push("opts ...RequestOption");

    const specFields = [`Method: ${JSON.stringify(op.method)}`, `Path: ${pathExpr}`];
    if (op.queryParams.length > 0) specFields.push("Query: q");
    if (op.headerParams.length > 0) specFields.push("Header: h");
    if (bodyArg) specFields.push("Body: body");
    if (op.idempotent) specFields.push("Idempotent: true");
    const summary = sanitizeSingleLine(op.summary || op.id);
    const sentence = /[.!?]$/.test(summary) ? summary : `${summary}.`;
    const doc = `// ${methodName} calls ${op.method} ${op.path}.\n//\n// ${sentence}\n${op.deprecated ? "//\n// Deprecated: see the API reference.\n" : ""}`;

    const r = op.response;
    const render = (retDecl, retErr, retBodyErr, bodyLines, extraSpec = []) => {
      const lines = pre.map((l) => l.replace("%RET_ERR%", retErr).replace("%RET_ERR_BODY%", retBodyErr));
      const fieldsText = [...specFields, ...extraSpec].join(", ");
      return `${doc}func (c *Client) ${methodName}(${args.join(", ")}) ${retDecl} {\n${lines.length ? `${lines.join("\n")}\n` : ""}\tspec := RequestSpec{${fieldsText}}\n${bodyLines.join("\n")}\n}`;
    };
    const bodyErr = (zero) => `${zero}&GradError{Code: "invalid_request", Message: ${JSON.stringify(`${methodName}: body is required`)}}`;

    if (r.kind === "json") {
      let retType;
      let kind;
      if (r.type.k === "ref") {
        retType = names.get(r.type.name);
        kind = typeOf(r.type, "").kind;
      } else {
        const t = typeOf(r.type, `${pascal}Response`);
        retType = t.type;
        kind = t.kind;
      }
      if (kind === "struct") {
        methods.push(
          render(`(*${retType}, error)`, "nil, err", bodyErr("nil, "), [
            `\tvar out ${retType}`,
            "\tif err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {",
            "\t\treturn nil, err",
            "\t}",
            "\treturn &out, nil",
          ]),
        );
      } else {
        methods.push(
          render(`(${retType}, error)`, "nil, err", bodyErr("nil, "), [
            `\tvar out ${retType}`,
            "\tif err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {",
            "\t\treturn nil, err",
            "\t}",
            "\treturn out, nil",
          ]),
        );
      }
    } else if (r.kind === "binary") {
      methods.push(render("(*StreamResponse, error)", "nil, err", bodyErr("nil, "), ["\treturn c.T.DoStream(ctx, spec, opts...)"], [`Accept: ${JSON.stringify(r.contentType)}`]));
    } else if (r.kind === "empty") {
      methods.push(render("error", "err", bodyErr(""), ["\treturn c.T.DoJSON(ctx, spec, nil, opts...)"]));
    }
    if (r.sse || r.kind === "sse-only") {
      const streamName = r.kind === "sse-only" ? methodName : `${methodName}Stream`;
      const lines = pre.map((l) => l.replace("%RET_ERR%", "nil, err").replace("%RET_ERR_BODY%", bodyErr("nil, ")));
      methods.push(
        `// ${streamName} opens ${op.method} ${op.path} as a Server-Sent Events stream (resume with WithLastEventID).\nfunc (c *Client) ${streamName}(${args.join(", ")}) (*SSEStream, error) {\n${lines.length ? `${lines.join("\n")}\n` : ""}\tspec := RequestSpec{${specFields.join(", ")}}\n\treturn c.T.DoSSE(ctx, spec, opts...)\n}`,
      );
    }
  }

  const sortedDecls = [...decls, ...enumDecls].sort((a, b) => compareStrings(a.name, b.name));
  const needsJSON = sortedDecls.some((d) => d.text.includes("json.Unmarshal"));
  const models = `${HEADER}\npackage generated\n${needsJSON ? '\nimport "encoding/json"\n' : ""}\n${sortedDecls.map((d) => d.text).join("\n\n")}\n`;

  const clientBody = methods.join("\n\n");
  const imports = ["context"];
  if (clientBody.includes("http.Header")) imports.push("net/http");
  if (clientBody.includes("url.Values")) imports.push("net/url");
  if (clientBody.includes("strconv.")) imports.push("strconv");
  imports.sort(compareStrings);
  const importBlock = imports.length === 1 ? `import "${imports[0]}"` : `import (\n${imports.map((i) => `\t"${i}"`).join("\n")}\n)`;
  const maxima = parameterMaxima(ir).map((m) => {
    const name = `${goName(m.op)}${goName(m.param)}Max`;
    return `// ${name} is the largest ${m.param} accepted by ${goName(m.op)} (the server clamps larger values).\nconst ${name} = ${m.maximum}`;
  });
  const maximaBlock = maxima.length ? `${maxima.join("\n\n")}\n\n` : "";
  const client = `${HEADER}\npackage generated\n\n${importBlock}\n\n${maximaBlock}// Client is the generated low-level client: one typed method per OpenAPI operation.\ntype Client struct {\n\tT *Transport\n}\n\n// NewClient wraps a Transport.\nfunc NewClient(t *Transport) *Client { return &Client{T: t} }\n\n${clientBody}\n`;

  const doc = `${HEADER}\n// Package generated is the low-level wire client for the Gradiated training and serving API.\n// Use the github.com/Gradiated/grad/sdks/go package instead; this one tracks spec/openapi.yaml exactly.\npackage generated\n`;
  return {
    "client.go": client,
    "doc.go": doc,
    "models.go": models,
  };
};
