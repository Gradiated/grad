import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildIR,
  extractOperations,
  generateAllTargets,
  generateFromSpec,
  parseSpecFile,
  toCamel,
  toPascal,
  toSnake,
} from "./generate-sdks.mjs";
import { goName, goParamIdent } from "./codegen/go.mjs";
import { rsIdent } from "./codegen/rust.mjs";
import { tsParamIdent, tsTypeName } from "./codegen/typescript.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const specPath = path.join(repoRoot, "spec", "openapi.yaml");
const fixturePath = path.join(scriptDir, "fixtures", "codegen-edge-cases.yaml");
const requireToolchains = process.env.GRAD_CODEGEN_REQUIRE_TOOLCHAINS === "1";

const scratch = (prefix) => mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), prefix));

const have = (cmd, args = ["version"]) => spawnSync(cmd, args, { encoding: "utf8" }).status === 0;

const run = (cmd, args, cwd, env = {}) => {
  const out = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(out.status, 0, `${cmd} ${args.join(" ")} failed in ${cwd}:\n${out.stdout}\n${out.stderr}`);
  return out.stdout;
};

const skipUnless = (t, ok, tool) => {
  if (ok) return false;
  if (requireToolchains) assert.fail(`${tool} is required (GRAD_CODEGEN_REQUIRE_TOOLCHAINS=1) but not on PATH`);
  t.skip(`${tool} not on PATH`);
  return true;
};

const writeFiles = (root, files, prefix) => {
  for (const [rel, content] of Object.entries(files)) {
    if (!rel.startsWith(prefix)) continue;
    const full = path.join(root, rel.slice(prefix.length));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
};

const fixture = async () => generateFromSpec(await parseSpecFile(fixturePath), { targets: ["ts", "go", "rs"] });

test("every operation in spec/openapi.yaml is generated for TypeScript, Go and Rust", async () => {
  const { ir, files } = await generateAllTargets(specPath);
  assert.ok(ir.operations.length >= 56, `expected >= 56 operations, got ${ir.operations.length}`);
  const ts = files["sdks/typescript/src/generated/client.ts"];
  const go = files["sdks/go/generated/client.go"];
  const rs = files["sdks/rust/src/generated.rs"];
  for (const op of ir.operations) {
    assert.match(ts, new RegExp(`\\n  (async )?${toCamel(op.id)}\\(`), `TS missing ${op.id}`);
    assert.ok(go.includes(`func (c *Client) ${goName(op.id)}(`), `Go missing ${op.id}`);
    assert.ok(rs.includes(`pub async fn ${toSnake(op.id)}(`), `Rust missing ${op.id}`);
  }
  // Typed signatures, not untyped records/maps.
  assert.ok(ts.includes("async createRun(body: PlanRunRequest, options?: RequestOptions): Promise<Run>"));
  assert.ok(!/\): Promise<Record<string, unknown>>/.test(ts));
  assert.ok(go.includes("func (c *Client) CreateRun(ctx context.Context, body *PlanRunRequest, opts ...RequestOption) (*Run, error)"));
  assert.ok(rs.includes("pub async fn create_run(&self, body: &PlanRunRequest) -> Result<PlanRunRequestRun, ApiError>") || rs.includes("pub async fn create_run(&self, body: &PlanRunRequest) -> Result<Run, ApiError>"));
  // Streams: binary downloads and SSE are never buffered as JSON.
  assert.ok(ts.includes("downloadArtifact(id: string, options?: StreamOptions): Promise<RawResponse>"));
  assert.ok(ts.includes("listRunMetricsStream("));
  assert.ok(go.includes("func (c *Client) DownloadArtifact(ctx context.Context, id string, opts ...RequestOption) (*StreamResponse, error)"));
  assert.ok(go.includes("func (c *Client) ListRunMetricsStream("));
  assert.ok(rs.includes("pub async fn download_artifact(&self, id: &str) -> Result<StreamResponse, ApiError>"));
  assert.ok(rs.includes("pub async fn list_run_metrics_stream("));
});

test("generated files on disk match the spec (no drift)", async () => {
  const { files } = await generateAllTargets(specPath);
  for (const [rel, expected] of Object.entries(files)) {
    if (rel.startsWith("sdks/python/")) continue; // owned by the Python emitter's own drift check
    assert.equal(readFileSync(path.join(repoRoot, rel), "utf8"), expected, `${rel} drifted; run node scripts/generate-sdks.mjs`);
  }
});

test("naming helpers sanitize any parameter name", () => {
  assert.equal(toSnake("getAPIKey"), "get_api_key");
  assert.equal(toCamel("after_step"), "afterStep");
  assert.equal(toCamel("page-size"), "pageSize");
  assert.equal(toPascal("list_runs"), "ListRuns");
  assert.equal(goName("run_id"), "RunID");
  assert.equal(goName("max_cost_usd"), "MaxCostUSD");
  assert.equal(goName("hf_repo"), "HFRepo");
  assert.equal(goName("1st_place"), "X1stPlace");
  assert.equal(goParamIdent("run_id"), "runID");
  assert.equal(goParamIdent("url"), "urlParam");
  assert.equal(goParamIdent("type"), "typeParam");
  assert.equal(goParamIdent("ctx"), "ctxParam");
  assert.equal(tsParamIdent("class"), "classParam");
  assert.equal(tsParamIdent("body"), "bodyParam");
  assert.equal(tsParamIdent("page-size"), "pageSize");
  assert.equal(tsTypeName("Record"), "RecordModel");
  assert.equal(rsIdent("type"), "r#type");
  assert.equal(rsIdent("self"), "self_");
  assert.equal(rsIdent("1st_place"), "n1st_place");
});

test("path params follow the template order, not declaration order", async () => {
  const { ir, files } = await fixture();
  const op = ir.operations.find((o) => o.id === "getCheckpointAtStep");
  assert.deepEqual(op.pathParams.map((p) => p.name), ["run_id", "step"]);
  assert.deepEqual(extractOperations(await parseSpecFile(fixturePath)).find((o) => o.operationId === "getCheckpointAtStep").pathParams, ["run_id", "step"]);
  assert.ok(files["sdks/go/generated/client.go"].includes('Path: "/v1/runs/" + p0 + "/checkpoints/" + p1'));
  assert.ok(files["sdks/go/generated/client.go"].includes('p0, err := EscapePathParam("run_id", runID)'));
  assert.ok(files["sdks/rust/src/generated.rs"].includes('format!("/v1/runs/{}/checkpoints/{}", encode_path_segment("run_id", run_id)?, encode_path_segment("step", step)?)'));
});

test("the IR fails loudly instead of silently dropping endpoints", () => {
  const base = (paths) => ({ openapi: "3.1.0", info: { title: "t", version: "1" }, paths });
  const ok = { "200": { description: "ok" } };
  assert.throws(() => buildIR(base({ "/a": { get: { responses: ok } } })), /no operationId/);
  assert.throws(
    () => buildIR(base({ "/a": { get: { operationId: "getItem", responses: ok } }, "/b": { get: { operationId: "get_item", responses: ok } } })),
    /Duplicate operationId/,
  );
  assert.throws(() => buildIR(base({ "/a/{id}": { get: { operationId: "a", responses: ok } } })), /'\{id\}' is not declared/);
  assert.throws(
    () => buildIR(base({ "/a": { get: { operationId: "a", parameters: [{ name: "id", in: "path", required: true }], responses: ok } } })),
    /declared but not in the path template/,
  );
  assert.throws(() => buildIR(base({ "/a": { get: { operationId: "a", responses: { "404": { description: "x" } } } } })), /no 2xx/);
  assert.throws(
    () => buildIR(base({ "/a": { get: { operationId: "a", responses: { "200": { description: "x", content: { "application/json": { schema: { $ref: "#/components/schemas/Nope" } } } } } } } })),
    /Unresolved \$ref/,
  );
  assert.throws(
    () => buildIR(base({ "/a": { get: { operationId: "a", parameters: [{ name: "c", in: "cookie" }], responses: ok } } })),
    /cookie/,
  );
});

test("output is deterministic across path order and locale", async () => {
  const spec = await parseSpecFile(specPath);
  const shuffled = { ...spec, paths: Object.fromEntries(Object.entries(spec.paths).reverse()) };
  const digest = async (s) => {
    const { files } = await generateFromSpec(s, { targets: ["ts", "go", "rs"] });
    return createHash("sha256").update(JSON.stringify(files)).digest("hex");
  };
  assert.equal(await digest(spec), await digest(shuffled));

  const script = `import("${path.join(scriptDir, "generate-sdks.mjs")}").then(async (m) => { const { files } = await m.generateAllTargets(${JSON.stringify(specPath)}); process.stdout.write(require("node:crypto").createHash("sha256").update(JSON.stringify(files)).digest("hex")); })`;
  const hashes = ["C", "tr_TR.UTF-8", "de_DE.UTF-8"].map((lang) => {
    const out = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, LANG: lang, LC_ALL: lang } });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout;
  });
  assert.equal(new Set(hashes).size, 1);
});

test("a top-level nullable object schema is an interface, and its uses add | null", async () => {
  const { files } = await fixture();
  const models = files["sdks/typescript/src/generated/models.ts"];
  assert.match(models, /\/\*\* A top-level nullable object[^*]*\*\/\nexport interface Heartbeat \{\n  at: string;\n\}/);
  assert.match(models, /heartbeat\?: Heartbeat \| null \| undefined;/);
  assert.doesNotMatch(models, /Heartbeat \| null \| null/);
});

test("fixture spec: generated TypeScript type-checks under strict settings and builds correct requests", async (t) => {
  const { files } = await fixture();
  const dir = scratch("codegen-ts-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFiles(path.join(dir, "src"), files, "sdks/typescript/src/");
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        lib: ["ES2022", "DOM"],
        types: [],
        outDir: "dist",
        rootDir: "src",
      },
      include: ["src"],
    }),
  );
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  run(path.join(repoRoot, "sdks", "typescript", "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], dir);

  writeFileSync(
    path.join(dir, "check.mjs"),
    `import assert from "node:assert/strict";
import { ApiClient, Transport, RedirectError } from "./dist/generated/index.js";
const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url, init });
  if (url.includes("/checkpoints/")) {
    return new Response(JSON.stringify({ id: "c1", run_id: "r1", step: 5, eval_score: null, format: "2bit", scores: { tests_passed: 1 }, metadata: { some_key: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.endsWith("/v1/items") && init.method === "POST") {
    return new Response(JSON.stringify({ id: "i1", created_at: "t", shape: { kind: "square", side_len: 2 } }), { status: 201 });
  }
  if (url.endsWith("/v1/items")) {
    return new Response(JSON.stringify([{ type: "x", "1st_place": true, "kebab-case": "k", extra_key: { keep_me: 1 }, content: [{ type: "y", nested: { inner_value: "v" } }] }]), { status: 200 });
  }
  if (url.includes("/v1/items/")) return new Response(null, { status: 204 });
  if (url.endsWith("/v1/events")) {
    return new Response("id: 1\\nevent: tick\\ndata: {\\"a\\":1}\\n\\n: ping\\n\\ndata: two\\ndata: lines\\n\\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  if (url.includes("/v1/blobs/")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
};
const api = new ApiClient(new Transport({ baseURL: "http://api.test/base/", apiKey: "k", fetch: fakeFetch, maxRetries: 0 }));

const ckpt = await api.getCheckpointAtStep("r 1", 5, { pageSize: 10, ctx: true, type: ["a", "b"], url: "u", xTraceId: "trace" });
const sent = new URL(calls[0].url);
assert.equal(sent.pathname, "/base/v1/runs/r%201/checkpoints/5");
assert.equal(sent.search, "?page-size=10&url=u&ctx=true&type=a&type=b");
assert.equal(calls[0].init.headers.get("x-trace-id"), "trace");
assert.equal(calls[0].init.headers.get("authorization"), "Bearer k");
assert.deepEqual(ckpt, { id: "c1", runId: "r1", step: 5, evalScore: null, format: "2bit", scores: { tests_passed: 1 }, metadata: { some_key: 1 } });

const created = await api.createItem({ name: "n", tree: { value: "root", lastSeen: { type: "t", camelCase: 1 } } });
assert.deepEqual(JSON.parse(calls[1].init.body), { name: "n", tree: { value: "root", last_seen: { type: "t", camelCase: 1 } } });
assert.deepEqual(created, { id: "i1", createdAt: "t", shape: { kind: "square", sideLen: 2 } });

const items = await api.listItems();
assert.deepEqual(items, [{ type: "x", "1stPlace": true, kebabCase: "k", extra_key: { keep_me: 1 }, content: [{ type: "y", nested: { innerValue: "v" } }] }]);

assert.equal(await api.deleteItem("a/b", "t", { self: "s" }), undefined);
assert.ok(calls.at(-1).url.endsWith("/v1/items/a%2Fb/t?self=s"));
await assert.rejects(() => api.deleteItem("..", "t"), /must be a non-empty value/);

const events = [];
for await (const e of api.streamEvents()) events.push(e);
assert.deepEqual(events, [
  { event: "tick", data: '{"a":1}', id: "1", retry: undefined },
  { event: "message", data: "two\\nlines", id: "1", retry: undefined },
]);
assert.equal(calls.at(-1).init.headers.get("accept"), "text/event-stream");

const blob = await api.downloadBlob("b1");
assert.deepEqual(new Uint8Array(await new Response(blob.body).arrayBuffer()), new Uint8Array([1, 2, 3]));

await assert.rejects(() => api.getLines(), RedirectError);
console.log("ok");
`,
  );
  assert.equal(run(process.execPath, ["check.mjs"], dir).trim(), "ok");
});

test("fixture spec: generated Go is gofmt-clean, vets, and builds correct requests", async (t) => {
  if (skipUnless(t, have("go"), "go")) return;
  const { files } = await fixture();
  const dir = scratch("codegen-go-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFiles(path.join(dir, "generated"), files, "sdks/go/generated/");
  writeFileSync(path.join(dir, "go.mod"), "module example.com/fixture\n\ngo 1.24\n");
  writeFileSync(
    path.join(dir, "generated", "fixture_test.go"),
    `package generated

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFixtureRequests(t *testing.T) {
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		switch r.URL.Path {
		case "/v1/runs/r 1/checkpoints/5":
			_, _ = w.Write([]byte(\`{"id":"c1","run_id":"r1","step":5,"eval_score":null,"format":"2bit","scores":{"a":1}}\`))
		case "/v1/items":
			_, _ = w.Write([]byte(\`[{"type":"x","1st_place":true,"extra":{"k":1}}]\`))
		default:
			http.Redirect(w, r, "https://evil.example/", http.StatusFound)
		}
	}))
	defer srv.Close()
	tr, err := NewTransport(Config{BaseURL: srv.URL, APIKey: "k"})
	if err != nil {
		t.Fatal(err)
	}
	c := NewClient(tr)
	ctx := context.Background()
	size := 10
	_ = size
	out, err := c.GetCheckpointAtStep(ctx, "r 1", 5, GetCheckpointAtStepParams{PageSize: 10, Ctx: Ptr(true), Type: []string{"a", "b"}, XTraceID: Ptr("trace")})
	if err != nil {
		t.Fatal(err)
	}
	if got.URL.RawQuery != "ctx=true&page-size=10&type=a&type=b" || got.Header.Get("X-Trace-Id") != "trace" || got.Header.Get("Authorization") != "Bearer k" {
		t.Fatalf("bad request: %s %v", got.URL.RawQuery, got.Header)
	}
	if out.RunID != "r1" || out.EvalScore != nil || out.Format == nil || *out.Format != Format2bit || out.Scores["a"] != 1 {
		t.Fatalf("bad decode: %+v", out)
	}
	items, err := c.ListItems(ctx)
	if err != nil || len(items) != 1 || items[0].X1stPlace == nil || !*items[0].X1stPlace || items[0].AdditionalProperties["extra"] == nil {
		t.Fatalf("bad items: %+v %v", items, err)
	}
	raw, _ := json.Marshal(items[0])
	if string(raw) != \`{"1st_place":true,"extra":{"k":1},"type":"x"}\` {
		t.Fatalf("round trip lost fields: %s", raw)
	}
	if _, err := c.GetCheckpointAtStep(ctx, "..", 1, GetCheckpointAtStepParams{}); err == nil {
		t.Fatal("dot-dot path param accepted")
	}
	var redirect *RedirectError
	if _, err := c.GetLines(ctx); !errors.As(err, &redirect) {
		t.Fatalf("cross-origin redirect not refused: %v", err)
	}
}
`,
  );
  const unformatted = run("gofmt", ["-l", "generated"], dir).trim();
  assert.equal(unformatted.split("\n").filter((f) => f && !f.endsWith("fixture_test.go")).join("\n"), "", "generated Go is not gofmt-clean");
  run("go", ["vet", "./..."], dir, { GOFLAGS: "-mod=mod" });
  run("go", ["test", "./..."], dir, { GOFLAGS: "-mod=mod" });

  const realDir = path.join(repoRoot, "sdks", "go", "generated");
  assert.equal(run("gofmt", ["-l", realDir], repoRoot).trim(), "", "sdks/go/generated is not gofmt-clean");
});

test("fixture spec: generated Rust passes cargo check", async (t) => {
  if (skipUnless(t, have("cargo"), "cargo")) return;
  const { files } = await fixture();
  const dir = scratch("codegen-rs-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "generated.rs"), files["sdks/rust/src/generated.rs"]);
  writeFileSync(
    path.join(dir, "src", "lib.rs"),
    `pub mod generated;

#[cfg(test)]
mod tests {
    use super::generated::*;

    #[test]
    fn enums_are_forward_compatible_and_records_keep_extra_fields() {
        let c: Checkpoint = serde_json::from_str(r#"{"id":"c","run_id":"r","step":1,"eval_score":null,"format":"from-the-future"}"#).unwrap();
        assert_eq!(c.format, Some(Format::Other("from-the-future".into())));
        let r: Record = serde_json::from_str(r#"{"type":"t","1st_place":true,"extra":1}"#).unwrap();
        assert_eq!(r.n1st_place, Some(true));
        assert_eq!(serde_json::to_string(&r).unwrap(), r#"{"type":"t","1st_place":true,"extra":1}"#);
        assert!(encode_path_segment("id", "..").is_err());
        assert_eq!(encode_path_segment("id", "a/b c").unwrap(), "a%2Fb%20c");
    }
}
`,
  );
  const manifest = readFileSync(path.join(repoRoot, "sdks", "rust", "Cargo.toml"), "utf8").replace(/\[dev-dependencies\][\s\S]*$/, "");
  writeFileSync(path.join(dir, "Cargo.toml"), `${manifest}\n[workspace]\n`);
  cpSync(path.join(repoRoot, "Cargo.lock"), path.join(dir, "Cargo.lock"));
  const env = { CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? path.join(dir, "target") };
  run("cargo", ["test", "--quiet"], dir, env);
});
