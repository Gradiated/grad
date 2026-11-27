import { randomBytes } from "node:crypto";

import { KMSClient } from "@aws-sdk/client-kms";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createKmsKeyWrapper } from "../src/cloud/kms.js";
import { createSecretsCipher, type KeyWrapper } from "../src/secrets.js";
import { makeTestApp } from "./fixtures/app.js";
import { startFakeKms, type FakeKms } from "./fixtures/fake-kms.js";

describe("secrets on AWS KMS (envelope encryption)", () => {
  let kms: FakeKms;
  let wrapper: KeyWrapper;

  beforeAll(async () => {
    kms = await startFakeKms();
    wrapper = createKmsKeyWrapper({
      client: new KMSClient({
        endpoint: kms.endpoint,
        region: "us-east-1",
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      }),
    });
  });
  afterAll(() => kms.close());

  const kmsCipher = (keyId: string, localKey?: string) => {
    const cipher = createSecretsCipher({
      kmsKeyId: keyId,
      kms: wrapper,
      ...(localKey ? { oldKeys: localKey } : {}),
    });
    if (!cipher) throw new Error("expected a cipher");
    return cipher;
  };

  it("seals each value under its own data key, wrapped with the workspace and name as context", async () => {
    const cipher = kmsCipher("alias/grad-secrets");
    expect(cipher.keyId).toBe("kms:alias/grad-secrets");
    expect(cipher.reseals).toBe(true);
    const a = await cipher.seal("ws_1", "hf-token", "hf_abc");
    const b = await cipher.seal("ws_1", "hf-token", "hf_abc");
    expect(a.keyId).toBe("kms:alias/grad-secrets");
    expect(a.wrappedKey?.equals(b.wrappedKey as Buffer)).toBe(false);
    expect(a.ciphertext.toString()).not.toContain("hf_abc");
    expect(await cipher.open("ws_1", "hf-token", a)).toBe("hf_abc");
    // Another workspace or name: KMS refuses the context, GCM the AAD.
    await expect(cipher.open("ws_2", "hf-token", a)).rejects.toThrow();
    await expect(cipher.open("ws_1", "other", a)).rejects.toThrow();
    await expect(
      cipher.open("ws_1", "hf-token", { ...a, wrappedKey: null }),
    ).rejects.toThrow(/no wrapped data key/);
    expect(kms.calls.filter((c) => c.op === "GenerateDataKey")).toHaveLength(2);
  });

  it("rotates to a new KMS key by re-wrapping the data key, ciphertext untouched", async () => {
    const before = kmsCipher("alias/old");
    const sealed = await before.seal("ws_1", "langfuse", "pk:sk");
    const after = kmsCipher("alias/new");
    const resealed = await after.reseal("ws_1", "langfuse", sealed);
    expect(resealed.keyId).toBe("kms:alias/new");
    expect(resealed.ciphertext.equals(sealed.ciphertext)).toBe(true);
    expect(resealed.nonce.equals(sealed.nonce)).toBe(true);
    expect(resealed.wrappedKey?.equals(sealed.wrappedKey as Buffer)).toBe(
      false,
    );
    expect(await after.open("ws_1", "langfuse", resealed)).toBe("pk:sk");
    expect(kms.calls.at(-2)).toEqual({ op: "ReEncrypt", keyId: "alias/new" });
  });

  it("migrates values sealed by GRAD_SECRETS_KEY onto KMS in the maintenance tick", async () => {
    const localKey = randomBytes(32).toString("base64");
    const local = await makeTestApp({
      secrets: createSecretsCipher({ key: localKey }),
    });
    expect(
      (
        await local.json("/v1/secrets", {
          body: { name: "hf-token", value: "hf_secret_1" },
        })
      ).status,
    ).toBe(200);
    expect(await local.services.sources.resealSecrets()).toBe(0);

    const cloud = await makeTestApp({
      store: local.deps.store,
      secrets: kmsCipher("alias/grad-secrets", localKey),
    });
    try {
      // Still readable before the move (the local key is an old key now).
      expect(
        await cloud.services.sources.revealSecret("ws_a", "hf-token", {
          url: "https://huggingface.co",
          use: "HF import",
        }),
      ).toBe("hf_secret_1");
      expect((await cloud.services.maintenance.tick()).resealedSecrets).toBe(1);
      expect(
        (await cloud.deps.store.secrets.getSealed("ws_a", "hf-token"))?.keyId,
      ).toBe("kms:alias/grad-secrets");
      expect(await cloud.services.sources.resealSecrets()).toBe(0);
      expect(
        await cloud.services.sources.revealSecret("ws_a", "hf-token", {
          url: "https://huggingface.co",
          use: "HF import",
        }),
      ).toBe("hf_secret_1");
    } finally {
      await cloud.close();
      await local.close();
    }
  });
});
