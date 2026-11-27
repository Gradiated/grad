import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createSecretsCipher } from "../src/secrets.js";

const newKey = (): string => randomBytes(32).toString("base64");

describe("createSecretsCipher", () => {
  it("returns null without a key, so writes can answer 501", () => {
    expect(createSecretsCipher({})).toBeNull();
    expect(() => createSecretsCipher({ oldKeys: newKey() })).toThrow(
      /needs GRAD_SECRETS_KEY/,
    );
  });

  it("rejects keys that are not 32 base64 bytes", () => {
    expect(() => createSecretsCipher({ key: "short" })).toThrow(
      /GRAD_SECRETS_KEY must be 32 random bytes/,
    );
    expect(() =>
      createSecretsCipher({
        key: randomBytes(16).toString("base64"),
      }),
    ).toThrow(/32 random bytes/);
    expect(() =>
      createSecretsCipher({ key: newKey(), oldKeys: "nope" }),
    ).toThrow(/GRAD_SECRETS_KEYS_OLD/);
  });

  it("round-trips with a fresh nonce and never stores the plaintext", () => {
    const cipher = createSecretsCipher({ key: newKey() });
    if (!cipher) throw new Error("expected a cipher");

    const a = cipher.seal("ws_1", "langfuse-prod", "pk-lf-1:sk-lf-2");
    const b = cipher.seal("ws_1", "langfuse-prod", "pk-lf-1:sk-lf-2");

    expect(a.keyId).toBe(cipher.keyId);
    expect(a.nonce).toHaveLength(12);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.toString("utf8")).not.toContain("sk-lf-2");
    expect(cipher.open("ws_1", "langfuse-prod", a)).toBe("pk-lf-1:sk-lf-2");
  });

  it("binds the value to its workspace and name", () => {
    const cipher = createSecretsCipher({ key: newKey() });
    if (!cipher) throw new Error("expected a cipher");
    const sealed = cipher.seal("ws_1", "hf-token", "hf_abc");

    expect(() => cipher.open("ws_2", "hf-token", sealed)).toThrow();
    expect(() => cipher.open("ws_1", "other", sealed)).toThrow();

    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() =>
      cipher.open("ws_1", "hf-token", { ...sealed, ciphertext: tampered }),
    ).toThrow();
  });

  it("reads values sealed with a rotated-out key", () => {
    const oldKey = newKey();
    const before = createSecretsCipher({ key: oldKey });
    if (!before) throw new Error("expected a cipher");
    const sealed = before.seal("ws_1", "hf-token", "hf_abc");

    const after = createSecretsCipher({ key: newKey(), oldKeys: oldKey });
    expect(after?.keyId).not.toBe(before.keyId);
    expect(after?.open("ws_1", "hf-token", sealed)).toBe("hf_abc");

    const forgotten = createSecretsCipher({ key: newKey() });
    expect(() => forgotten?.open("ws_1", "hf-token", sealed)).toThrow(
      /neither GRAD_SECRETS_KEY nor in GRAD_SECRETS_KEYS_OLD/,
    );
  });
});
