import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractOperations,
  generateAllTargets,
  generateGo,
  generatePython,
  generateRust,
  generateTypeScript,
  safeIdent,
  toCamel,
  toPascal,
  toSnake,
} from "./generate-sdks.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

test("generates every OpenAPI operation across TypeScript, Python, Go, and Rust", async () => {
  const specPath = path.join(repoRoot, "spec", "openapi.yaml");
  const { ops, files } = await generateAllTargets(specPath);

  assert.ok(ops.length >= 28, `expected >= 28 operations, got ${ops.length}`);

  const ts = files["sdks/typescript/src/generated/client.ts"];
  const py = files["sdks/python/grad/_generated/client.py"];
  const go = files["sdks/go/generated/client.go"];
  const rs = files["sdks/rust/src/generated.rs"];

  for (const op of ops) {
    assert.ok(ts.includes(`${op.operationId}(`), `TS missing ${op.operationId}`);
    assert.ok(
      py.includes(`def ${toSnake(op.operationId)}(`),
      `Python missing ${toSnake(op.operationId)}`,
    );
    assert.ok(
      go.includes(`func (c *Client) ${toPascal(op.operationId)}(`),
      `Go missing ${toPascal(op.operationId)}`,
    );
    assert.ok(
      rs.includes(`pub async fn ${toSnake(op.operationId)}(`),
      `Rust missing ${toSnake(op.operationId)}`,
    );
  }

  assert.ok(ts.includes("downloadArtifact(id: string): Promise<{ bytes: Uint8Array"));
  assert.ok(py.includes("def download_artifact(self, id: str) -> tuple[bytes, dict[str, str]]:"));
  assert.ok(go.includes("func (c *Client) DownloadArtifact(ctx context.Context, id string) ([]byte, http.Header, error)"));
  assert.ok(rs.includes("pub async fn download_artifact(&self, id: &str) -> Result<(Vec<u8>, Option<String>), ApiError>"));
});

test("handles naming helpers, reserved keywords, comment escaping, allOf, and duplicate operationIds", () => {
  assert.equal(toSnake("getAPIKey"), "get_api_key");
  assert.equal(toCamel("after_step"), "afterStep");
  assert.equal(toPascal("getRunId"), "GetRunID");
  assert.equal(safeIdent("type", "go"), "type_");
  assert.equal(safeIdent("match", "rs"), "r#match");
  assert.equal(safeIdent("class", "py"), "class_");

  const synthetic = {
    paths: {
      "/v1/items/{type}": {
        delete: {
          operationId: "deleteItem",
          summary: 'Dangerous */ """\nline2',
          parameters: [{ name: "type", in: "path", required: true }],
          responses: { "204": { description: "No content" } },
        },
      },
    },
    components: {
      schemas: {
        Combined: {
          allOf: [
            { type: "object", properties: { a: { const: "x" } }, required: ["a"] },
            { type: "object", properties: { b: { type: "number" } } },
          ],
        },
      },
    },
  };
  const ops = extractOperations(synthetic);
  const ts = generateTypeScript(synthetic, ops);
  const py = generatePython(synthetic, ops);
  const go = generateGo(synthetic, ops);
  const rs = generateRust(synthetic, ops);

  assert.ok(ts.includes('export type Combined = {\n  a: "x";\n} & {\n  b?: number;\n};'));
  assert.ok(!ts.includes("Dangerous */"));
  assert.ok(py.includes('\\"\\"\\"'));
  assert.ok(go.includes("type_ string"));
  assert.ok(rs.includes("r#type: &str"));

  assert.throws(
    () =>
      extractOperations({
        paths: {
          "/a": { get: { operationId: "getItem" } },
          "/b": { get: { operationId: "get_item" } },
        },
      }),
    /Duplicate operationId/,
  );
});
