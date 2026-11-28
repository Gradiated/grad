import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { ChecksumMismatchError, GradError } from "../src/index.js";
import { FakeServer, makeGrad } from "./helpers.js";

/** A minimal ustar writer for test bundles: [name, body, typeflag]. */
const tarGz = (entries: Array<[string, string, string?]>): Uint8Array => {
  const blocks: Buffer[] = [];
  for (const [name, body, type = "0"] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write(`${Buffer.byteLength(body).toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(type, 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const data = Buffer.from(body);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
};

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const manifest = (files: Record<string, string>) =>
  JSON.stringify({ format: "peft_lora", files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha(b)])) });

const FILES = { "adapter_config.json": '{"r":32}', "adapter_model.safetensors": "weights" };
const BUNDLES: Record<string, Uint8Array> = {
  good: tarGz([["manifest.json", manifest(FILES)], ...Object.entries(FILES)]),
  traversal: tarGz([["manifest.json", manifest({})], ["../escape", "x"]]),
  symlink: tarGz([["manifest.json", manifest({})], ["link", "", "2"]]),
  tampered: tarGz([["manifest.json", manifest(FILES)], ["adapter_config.json", "{}"], ["adapter_model.safetensors", "weights"]]),
  unlisted: tarGz([["manifest.json", manifest({})], ["extra.bin", "x"]]),
  // A name that is a property of every object ("constructor" in {} is true) is still unlisted.
  "unlisted-proto": tarGz([["manifest.json", manifest({})], ["constructor", "x"]]),
};

const server = () => {
  const s = new FakeServer();
  for (const [ref, body] of Object.entries(BUNDLES)) {
    s.on("GET", `/v1/artifacts/${ref}/download`, new Response(body as BodyInit, { status: 200, headers: { "x-artifact-sha256": sha(body) } }));
  }
  return s;
};

describe("artifact downloads with extract", () => {
  it("writes the verified files into a new directory and nothing else", async () => {
    const { grad } = makeGrad(server());
    const root = mkdtempSync(path.join(tmpdir(), "grad-extract-"));
    const dest = path.join(root, "support-sft");
    const result = await grad.artifacts.download("good", dest, { extract: true });
    expect(result.path).toBe(dest);
    for (const [name, body] of Object.entries(FILES)) expect(readFileSync(path.join(dest, name), "utf8")).toBe(body);
    expect(readdirSync(root)).toEqual(["support-sft"]);
    await expect(grad.artifacts.download("good", dest, { extract: true })).rejects.toThrow(/not empty/);
  });

  it.each(["traversal", "symlink", "tampered", "unlisted", "unlisted-proto"])("refuses a %s bundle and leaves nothing behind", async (ref) => {
    const { grad } = makeGrad(server());
    const root = mkdtempSync(path.join(tmpdir(), "grad-extract-"));
    const dest = path.join(root, "out");
    const error = await grad.artifacts.download(ref, dest, { extract: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GradError);
    if (ref === "tampered") expect(error).toBeInstanceOf(ChecksumMismatchError);
    else expect((error as GradError).code).toBe("unsafe_archive");
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});
