/**
 * Language-neutral intermediate representation of an OpenAPI 3.x document.
 *
 * Every emitter (TypeScript, Python, Go, Rust) reads this IR instead of the raw
 * spec, so spec quirks (3.0 `nullable`, 3.1 type arrays, nullable `allOf`
 * wrappers, path-level parameters, `$ref`ed parameters) are resolved once.
 *
 * The IR is strict: anything an emitter cannot represent faithfully throws,
 * so an endpoint can never silently disappear from the SDKs.
 */

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

const IDEMPOTENCY_HEADER = "idempotency-key";

const OPERATION_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TEMPLATE_PARAM_RE = /\{([^}]+)\}/g;

/** Locale-independent, byte-stable string comparison (never `localeCompare`). */
export const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const toSnake = (name) =>
  String(name)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

export const toCamel = (name) => {
  const snake = toSnake(name);
  if (snake === "") return "";
  return snake.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
};

export const toPascal = (name) => {
  const camel = toCamel(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const refName = (ref, where) => {
  const match = /^#\/components\/schemas\/([^/]+)$/.exec(String(ref));
  if (!match) throw new Error(`Unsupported $ref '${ref}' at ${where}; only #/components/schemas/* is supported.`);
  return decodeURIComponent(match[1]);
};

const NULL_ONLY = (schema) =>
  isPlainObject(schema) &&
  (schema.type === "null" || (Array.isArray(schema.type) && schema.type.every((t) => t === "null")));

/** `{type: ["object", "null"]}` (or `nullable: true`) with nothing else: an allOf nullability marker. */
const isNullabilityMarker = (schema) => {
  if (!isPlainObject(schema)) return false;
  const keys = Object.keys(schema).filter((k) => !["description", "title", "type", "nullable"].includes(k));
  if (keys.length > 0) return false;
  if (schema.nullable === true) return true;
  return Array.isArray(schema.type) && schema.type.includes("null");
};

const nullable = (inner) => (inner.k === "nullable" || inner.k === "any" || inner.k === "null" ? inner : { k: "nullable", inner });

/**
 * Normalizes one JSON schema into a TypeNode:
 *   ref | prim | null | any | enum | array | object | map | union | nullable
 */
export const normalizeSchema = (schema, where, schemas) => {
  if (schema === true || schema === undefined || (isPlainObject(schema) && Object.keys(schema).length === 0)) {
    return { k: "any" };
  }
  if (!isPlainObject(schema)) throw new Error(`Invalid schema at ${where}.`);
  const meta = {};
  if (typeof schema.description === "string") meta.description = schema.description;
  if (schema.default !== undefined) meta.default = schema.default;
  if (schema.deprecated === true) meta.deprecated = true;
  const withMeta = (node) => (Object.keys(meta).length ? { ...node, ...meta } : node);

  if (schema.$ref) {
    const name = refName(schema.$ref, where);
    if (!schemas || !(name in schemas)) throw new Error(`Unresolved $ref '${schema.$ref}' at ${where}.`);
    return withMeta({ k: "ref", name });
  }

  if (schema.nullable === true) {
    const { nullable: _drop, ...rest } = schema;
    return withMeta(nullable(normalizeSchema(rest, where, schemas)));
  }

  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.filter((part) => !isNullabilityMarker(part));
    const isNullable = parts.length !== schema.allOf.length;
    let node;
    if (parts.length === 1) {
      node = normalizeSchema(parts[0], `${where}.allOf[0]`, schemas);
    } else {
      const normalized = parts.map((p, i) => normalizeSchema(p, `${where}.allOf[${i}]`, schemas));
      const resolved = normalized.map((n) => (n.k === "ref" ? normalizeSchema(schemas[n.name], n.name, schemas) : n));
      if (!resolved.every((n) => n.k === "object")) {
        throw new Error(`allOf at ${where} mixes non-object members; cannot merge.`);
      }
      const props = [];
      const seen = new Map();
      for (const part of resolved) {
        for (const prop of part.props) {
          if (seen.has(prop.name)) {
            const prev = props[seen.get(prop.name)];
            props[seen.get(prop.name)] = { ...prev, required: prev.required || prop.required };
          } else {
            seen.set(prop.name, props.length);
            props.push(prop);
          }
        }
      }
      const additional = resolved.find((p) => p.additional !== undefined)?.additional;
      node = { k: "object", props, ...(additional !== undefined ? { additional } : {}) };
    }
    return withMeta(isNullable ? nullable(node) : node);
  }

  for (const key of ["oneOf", "anyOf"]) {
    if (Array.isArray(schema[key])) {
      const variants = schema[key];
      const isNullable = variants.some(NULL_ONLY);
      const rest = variants
        .filter((v) => !NULL_ONLY(v))
        .map((v, i) => normalizeSchema(v, `${where}.${key}[${i}]`, schemas));
      let node;
      if (rest.length === 0) node = { k: "null" };
      else if (rest.length === 1) node = rest[0];
      else {
        node = { k: "union", variants: rest };
        if (isPlainObject(schema.discriminator) && typeof schema.discriminator.propertyName === "string") {
          node.discriminator = schema.discriminator.propertyName;
        }
      }
      return withMeta(isNullable ? nullable(node) : node);
    }
  }

  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== "null");
    const isNullable = types.length !== schema.type.length;
    let node;
    if (types.length === 0) node = { k: "null" };
    else if (types.length === 1) node = normalizeSchema({ ...schema, type: types[0] }, where, schemas);
    else node = { k: "union", variants: types.map((t) => normalizeSchema({ ...schema, type: t }, where, schemas)) };
    return withMeta(isNullable ? nullable(node) : node);
  }

  if (schema.const !== undefined) {
    if (schema.const === null) return withMeta({ k: "null" });
    return withMeta({ k: "enum", base: typeof schema.const, values: [schema.const] });
  }

  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((v) => v !== null);
    if (values.length === 0) return withMeta({ k: "null" });
    const bases = new Set(values.map((v) => (typeof v === "number" && Number.isInteger(v) && schema.type === "integer" ? "integer" : typeof v)));
    if (bases.size !== 1 || ![...bases].every((b) => ["string", "number", "integer", "boolean"].includes(b))) {
      throw new Error(`Enum at ${where} mixes value types; unsupported.`);
    }
    const node = { k: "enum", base: [...bases][0], values };
    return withMeta(values.length !== schema.enum.length ? nullable(node) : node);
  }

  const type = schema.type ?? (schema.properties || schema.additionalProperties !== undefined ? "object" : schema.items ? "array" : undefined);
  switch (type) {
    case undefined:
      return withMeta({ k: "any" });
    case "null":
      return withMeta({ k: "null" });
    case "string":
      return withMeta({ k: "prim", t: schema.format === "binary" ? "binary" : "string", ...(schema.format ? { format: schema.format } : {}) });
    case "integer":
    case "number":
    case "boolean":
      return withMeta({ k: "prim", t: type });
    case "array":
      return withMeta({ k: "array", items: normalizeSchema(schema.items, `${where}[]`, schemas) });
    case "object": {
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const props = Object.entries(schema.properties ?? {}).map(([name, sub]) => ({
        name,
        required: required.has(name),
        type: normalizeSchema(sub, `${where}.${name}`, schemas),
      }));
      for (const name of required) {
        if (!(name in (schema.properties ?? {})) && props.length > 0) {
          throw new Error(`Required property '${name}' at ${where} is not declared in properties.`);
        }
      }
      const ap = schema.additionalProperties;
      if (props.length === 0) {
        if (ap === false) return withMeta({ k: "object", props: [], additional: false });
        return withMeta({ k: "map", values: ap === undefined || ap === true ? { k: "any" } : normalizeSchema(ap, `${where}{}`, schemas) });
      }
      let additional;
      if (ap === true || isPlainObject(ap)) additional = ap === true ? { k: "any" } : normalizeSchema(ap, `${where}{}`, schemas);
      else if (ap === false) additional = false;
      return withMeta({ k: "object", props, ...(additional !== undefined ? { additional } : {}) });
    }
    default:
      throw new Error(`Unsupported schema type '${type}' at ${where}.`);
  }
};

const resolveParameter = (param, spec, where) => {
  if (param && param.$ref) {
    const match = /^#\/components\/parameters\/([^/]+)$/.exec(param.$ref);
    const resolved = match ? spec.components?.parameters?.[decodeURIComponent(match[1])] : undefined;
    if (!resolved) throw new Error(`Unresolved parameter $ref '${param.$ref}' at ${where}.`);
    return resolved;
  }
  if (!isPlainObject(param) || typeof param.name !== "string" || typeof param.in !== "string") {
    throw new Error(`Invalid parameter at ${where}.`);
  }
  return param;
};

const classifyContentType = (contentType) => {
  const ct = contentType.toLowerCase();
  if (ct === "text/event-stream") return "sse";
  if (ct === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(ct)) return "json";
  return "binary";
};

const stableJson = (value) => JSON.stringify(value, (_, v) => (isPlainObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => compareStrings(a, b))) : v));

const buildResponse = (op, where, schemas) => {
  const codes = Object.keys(op.responses ?? {})
    .filter((code) => /^2(\d\d|XX)$/i.test(code))
    .sort(compareStrings);
  if (codes.length === 0) throw new Error(`${where} declares no 2xx response.`);

  let primary;
  let sse = false;
  let schemaKey;
  for (const code of codes) {
    const response = op.responses[code] ?? {};
    const content = response.content ?? {};
    const entries = Object.entries(content);
    let candidate;
    if (code === "204" || entries.length === 0) {
      candidate = { kind: "empty" };
    } else {
      const byKind = new Map();
      for (const [ct, media] of entries) {
        const kind = classifyContentType(ct);
        if (!byKind.has(kind)) byKind.set(kind, { contentType: ct, media });
      }
      if (byKind.has("sse")) sse = true;
      if (byKind.has("json")) {
        const { contentType, media } = byKind.get("json");
        candidate = { kind: "json", contentType, type: normalizeSchema(media?.schema, `${where} ${code} response`, schemas) };
      } else if (byKind.has("binary")) {
        candidate = { kind: "binary", contentType: byKind.get("binary").contentType };
      } else {
        candidate = { kind: "sse-only", contentType: "text/event-stream" };
      }
    }
    const key = stableJson(candidate.type ?? candidate.kind);
    if (primary === undefined) {
      primary = { ...candidate, status: code };
      schemaKey = key;
    } else if (key !== schemaKey && candidate.kind !== "empty") {
      throw new Error(`${where} declares differing 2xx response bodies (${primary.status} vs ${code}); unsupported.`);
    }
  }
  return { ...primary, sse };
};

const buildBody = (op, where, schemas) => {
  if (!op.requestBody) return null;
  const rb = op.requestBody.$ref ? null : op.requestBody;
  if (!rb) throw new Error(`${where}: requestBody $ref is unsupported.`);
  const entries = Object.entries(rb.content ?? {});
  if (entries.length === 0) throw new Error(`${where}: requestBody has no content.`);
  const json = entries.find(([ct]) => classifyContentType(ct) === "json");
  if (json) {
    return {
      kind: "json",
      contentType: json[0],
      required: Boolean(rb.required),
      type: normalizeSchema(json[1]?.schema, `${where} requestBody`, schemas),
    };
  }
  return { kind: "binary", contentType: entries[0][0], required: Boolean(rb.required) };
};

/**
 * Builds the full IR. Throws on anything ambiguous or unsupported.
 */
export const buildIR = (spec) => {
  if (!isPlainObject(spec)) throw new Error("OpenAPI document must be an object.");
  const rawSchemas = spec.components?.schemas ?? {};
  const schemas = {};
  for (const name of Object.keys(rawSchemas).sort(compareStrings)) {
    schemas[name] = normalizeSchema(rawSchemas[name], `components.schemas.${name}`, rawSchemas);
  }

  const operations = [];
  const seenIds = new Map();
  for (const routePath of Object.keys(spec.paths ?? {}).sort(compareStrings)) {
    const pathItem = spec.paths[routePath];
    if (!isPlainObject(pathItem)) continue;
    const shared = (pathItem.parameters ?? []).map((p, i) => resolveParameter(p, spec, `${routePath} parameters[${i}]`));

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const where = `${method.toUpperCase()} ${routePath}`;
      if (!op.operationId) {
        throw new Error(`${where} has no operationId; every operation must have one or it would be missing from the SDKs.`);
      }
      if (!OPERATION_ID_RE.test(op.operationId)) {
        throw new Error(`Invalid operationId '${op.operationId}' on ${where}.`);
      }
      const normalized = toSnake(op.operationId);
      if (seenIds.has(normalized)) {
        throw new Error(`Duplicate operationId '${op.operationId}' (normalized '${normalized}', also on ${seenIds.get(normalized)}).`);
      }
      seenIds.set(normalized, where);

      const merged = new Map();
      for (const param of shared) merged.set(`${param.in}:${param.name}`, param);
      for (const [i, raw] of (op.parameters ?? []).entries()) {
        const param = resolveParameter(raw, spec, `${where} parameters[${i}]`);
        merged.set(`${param.in}:${param.name}`, param);
      }
      const params = [...merged.values()];
      for (const param of params) {
        if (!["path", "query", "header", "cookie"].includes(param.in)) {
          throw new Error(`${where}: parameter '${param.name}' has unsupported location '${param.in}'.`);
        }
        if (param.in === "cookie") throw new Error(`${where}: cookie parameter '${param.name}' is unsupported.`);
      }

      const templateNames = [...routePath.matchAll(TEMPLATE_PARAM_RE)].map((m) => m[1]);
      if (new Set(templateNames).size !== templateNames.length) {
        throw new Error(`${where}: path template repeats a parameter.`);
      }
      const declaredPath = new Map(params.filter((p) => p.in === "path").map((p) => [p.name, p]));
      for (const name of templateNames) {
        if (!declaredPath.has(name)) throw new Error(`${where}: path parameter '{${name}}' is not declared.`);
      }
      for (const name of declaredPath.keys()) {
        if (!templateNames.includes(name)) throw new Error(`${where}: path parameter '${name}' is declared but not in the path template.`);
      }

      const toParam = (p) => {
        const type = normalizeSchema(p.schema, `${where} parameter ${p.name}`, rawSchemas);
        const base = type.k === "nullable" ? type.inner : type;
        const scalarOk = (n) => n.k === "prim" || n.k === "enum" || n.k === "any";
        if (!(scalarOk(base) || (base.k === "array" && scalarOk(base.items)))) {
          throw new Error(`${where}: parameter '${p.name}' must be a scalar or an array of scalars.`);
        }
        const maximum = base.k === "prim" && base.t === "integer" && typeof p.schema?.maximum === "number" ? p.schema.maximum : undefined;
        return {
          name: p.name,
          in: p.in,
          required: p.in === "path" ? true : Boolean(p.required),
          type,
          ...(typeof p.description === "string" ? { description: p.description } : {}),
          ...(maximum !== undefined ? { maximum } : {}),
        };
      };

      // Path params are listed in *template* order so positional formatting can never swap them.
      const pathParams = templateNames.map((name) => toParam(declaredPath.get(name)));
      const queryParams = params.filter((p) => p.in === "query").map(toParam);
      // `Idempotency-Key` is transport policy, not a method argument: the SDK
      // transports generate one per logical call and reuse it across retries.
      const idempotent = params.some((p) => p.in === "header" && p.name.toLowerCase() === IDEMPOTENCY_HEADER);
      const headerParams = params.filter((p) => p.in === "header" && p.name.toLowerCase() !== IDEMPOTENCY_HEADER).map(toParam);
      const segments = routePath.split(TEMPLATE_PARAM_RE);

      operations.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path: routePath,
        // Alternating literal / param-name pieces: ["/v1/runs/", "id", "/metrics"].
        segments,
        summary: typeof op.summary === "string" ? op.summary : "",
        description: typeof op.description === "string" ? op.description : "",
        deprecated: op.deprecated === true,
        tags: Array.isArray(op.tags) ? [...op.tags] : [],
        internal: op["x-internal"] === true,
        idempotent,
        pathParams,
        queryParams,
        headerParams,
        body: buildBody(op, where, rawSchemas),
        response: buildResponse(op, where, rawSchemas),
      });
    }
  }

  operations.sort((a, b) => compareStrings(a.id, b.id));
  return { title: spec.info?.title ?? "", version: spec.info?.version ?? "", schemas, operations };
};

/**
 * Legacy flat view consumed by the Python emitter: same field names as before,
 * but path params are in template order and ops without operationId throw.
 */
export const extractOperations = (spec) =>
  buildIR(spec).operations.map((op) => ({
    operationId: op.id,
    summary: op.summary,
    method: op.method,
    path: op.path,
    pathParams: op.pathParams.map((p) => p.name),
    queryParams: op.queryParams.map((q) => ({ name: q.name, required: q.required })),
    tags: op.tags,
    internal: op.internal,
    idempotent: op.idempotent,
    hasBody: op.body !== null,
    bodyRequired: Boolean(op.body?.required),
    isBinary: op.response.kind === "binary",
  }));

/** Walks a TypeNode tree (not following refs). */
export const walkType = (node, visit) => {
  visit(node);
  switch (node.k) {
    case "nullable":
      walkType(node.inner, visit);
      break;
    case "array":
      walkType(node.items, visit);
      break;
    case "map":
      walkType(node.values, visit);
      break;
    case "union":
      node.variants.forEach((v) => walkType(v, visit));
      break;
    case "object":
      node.props.forEach((p) => walkType(p.type, visit));
      if (node.additional && node.additional !== false) walkType(node.additional, visit);
      break;
    default:
  }
};

export const sanitizeSingleLine = (text) =>
  String(text ?? "")
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();

/** Schema names reachable from `operations` (following refs transitively). */
const reachableSchemas = (schemas, operations) => {
  const seen = new Set();
  const pending = [];
  const visit = (node) => {
    if (node.k === "ref" && !seen.has(node.name)) {
      seen.add(node.name);
      pending.push(schemas[node.name]);
    }
  };
  for (const op of operations) {
    for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams]) walkType(p.type, visit);
    if (op.body?.type) walkType(op.body.type, visit);
    if (op.response.type) walkType(op.response.type, visit);
  }
  while (pending.length > 0) walkType(pending.pop(), visit);
  return seen;
};

/** `roots` plus every schema they reference (transitively). */
export const schemaClosure = (schemas, roots) => {
  const seen = new Set();
  const pending = [];
  const visit = (node) => {
    if (node.k === "ref" && !seen.has(node.name)) {
      seen.add(node.name);
      pending.push(schemas[node.name]);
    }
  };
  for (const name of roots) {
    if (!(name in schemas)) throw new Error(`Schema '${name}' is not in the spec.`);
    visit({ k: "ref", name });
  }
  while (pending.length > 0) walkType(pending.pop(), visit);
  return seen;
};

/**
 * The IR without `x-internal` operations (worker protocols) and without the
 * schemas only they use: what the public SDK clients are generated from.
 */
export const publicIR = (ir) => {
  const operations = ir.operations.filter((op) => !op.internal);
  const keep = reachableSchemas(ir.schemas, operations);
  const schemas = Object.fromEntries(Object.entries(ir.schemas).filter(([name]) => keep.has(name)));
  return { ...ir, operations, schemas };
};

/** Integer query parameters with a documented `maximum` (page sizes), per operation. */
export const parameterMaxima = (ir) =>
  ir.operations.flatMap((op) =>
    op.queryParams.filter((p) => p.maximum !== undefined).map((p) => ({ op: op.id, param: p.name, maximum: p.maximum })),
  );
