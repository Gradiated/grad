import { describe, expect, it } from "vitest";

import {
  BLOB_DOWNLOAD_PATH,
  BLOB_UPLOAD_PREFIX,
  createBlobSigner,
} from "../src/storage/signer.js";

const now = new Date("2026-11-27T12:00:00.000Z");
const later = new Date(now.getTime() + 60_000);

const params = (url: string): URLSearchParams =>
  new URL(url, "http://grad.local").searchParams;

describe("BlobSigner", () => {
  const signer = createBlobSigner("test-secret");

  it("signs and verifies upload URLs until they expire", () => {
    const url = signer.uploadPath("upl_123", later);
    expect(url.startsWith(`${BLOB_UPLOAD_PREFIX}upl_123?`)).toBe(true);
    const q = params(url);
    const exp = q.get("exp") ?? "";
    const sig = q.get("sig") ?? "";

    expect(signer.verifyUpload("upl_123", exp, sig, now)).toBe(true);
    expect(
      signer.verifyUpload("upl_123", exp, sig, new Date(later.getTime() + 1)),
    ).toBe(false);
  });

  it("signs and verifies download URLs bound to the object key", () => {
    const url = signer.downloadPath("checkpoints/ws a/ckpt.tar.gz", later);
    expect(url.startsWith(`${BLOB_DOWNLOAD_PATH}?`)).toBe(true);
    const q = params(url);
    const key = q.get("key") ?? "";
    const exp = q.get("exp") ?? "";
    const sig = q.get("sig") ?? "";

    expect(key).toBe("checkpoints/ws a/ckpt.tar.gz");
    expect(signer.verifyDownload(key, exp, sig, now)).toBe(true);
    expect(signer.verifyDownload("checkpoints/other", exp, sig, now)).toBe(
      false,
    );
  });

  it("rejects tampered expiry, signature, or subject", () => {
    const q = params(signer.uploadPath("upl_1", later));
    const exp = q.get("exp") ?? "";
    const sig = q.get("sig") ?? "";

    expect(signer.verifyUpload("upl_2", exp, sig, now)).toBe(false);
    expect(
      signer.verifyUpload("upl_1", String(Number(exp) + 1000), sig, now),
    ).toBe(false);
    expect(signer.verifyUpload("upl_1", exp, `${sig.slice(0, -1)}A`, now)).toBe(
      false,
    );
    expect(signer.verifyUpload("upl_1", exp, "short", now)).toBe(false);
    expect(signer.verifyUpload("upl_1", "not-a-number", sig, now)).toBe(false);
  });

  it("separates purposes: an upload signature never authorizes a download", () => {
    const q = params(signer.uploadPath("same-subject", later));

    expect(
      signer.verifyDownload(
        "same-subject",
        q.get("exp") ?? "",
        q.get("sig") ?? "",
        now,
      ),
    ).toBe(false);
  });

  it("does not accept signatures from a different secret", () => {
    const other = createBlobSigner("other-secret");
    const q = params(other.uploadPath("upl_1", later));

    expect(
      signer.verifyUpload("upl_1", q.get("exp") ?? "", q.get("sig") ?? "", now),
    ).toBe(false);
  });

  it("uses a random secret when none is configured", () => {
    const a = createBlobSigner();
    const b = createBlobSigner();
    const q = params(a.uploadPath("upl_1", later));

    expect(
      a.verifyUpload("upl_1", q.get("exp") ?? "", q.get("sig") ?? "", now),
    ).toBe(true);
    expect(
      b.verifyUpload("upl_1", q.get("exp") ?? "", q.get("sig") ?? "", now),
    ).toBe(false);
  });
});
