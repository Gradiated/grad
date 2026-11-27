import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake AWS KMS speaking the real wire protocol (awsJson1.1,
 * `X-Amz-Target: TrentService.<Op>`), so the AWS SDK client in
 * src/cloud/kms.ts runs unmodified. GenerateDataKey, Decrypt and ReEncrypt
 * with encryption contexts; each key id is its own AES key.
 */
export interface FakeKms {
  endpoint: string;
  calls: Array<{ op: string; keyId: string | null }>;
  close(): Promise<void>;
}

const sorted = (context: unknown): string =>
  JSON.stringify(
    Object.entries((context ?? {}) as Record<string, string>).sort(),
  );

export const startFakeKms = async (): Promise<FakeKms> => {
  const keys = new Map<string, Buffer>();
  const keyFor = (id: string) => {
    let key = keys.get(id);
    if (!key) {
      key = randomBytes(32);
      keys.set(id, key);
    }
    return key;
  };
  const calls: FakeKms["calls"] = [];

  /** Blob: keyId length, keyId, nonce, tag, ciphertext (context is the AAD). */
  const wrap = (keyId: string, plaintext: Buffer, context: unknown) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyFor(keyId), nonce);
    cipher.setAAD(Buffer.from(sorted(context)));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const id = Buffer.from(keyId);

    return Buffer.concat([
      Buffer.from([id.length]),
      id,
      nonce,
      cipher.getAuthTag(),
      body,
    ]);
  };
  const unwrap = (blob: Buffer, context: unknown) => {
    const idLength = blob[0] ?? 0;
    const keyId = blob.subarray(1, 1 + idLength).toString();
    const rest = blob.subarray(1 + idLength);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyFor(keyId),
      rest.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(sorted(context)));
    decipher.setAuthTag(rest.subarray(12, 28));

    return {
      keyId,
      plaintext: Buffer.concat([
        decipher.update(rest.subarray(28)),
        decipher.final(),
      ]),
    };
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const op = String(req.headers["x-amz-target"] ?? "").split(".")[1] ?? "";
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
        KeyId?: string;
        CiphertextBlob?: string;
        EncryptionContext?: unknown;
        SourceEncryptionContext?: unknown;
        DestinationKeyId?: string;
        DestinationEncryptionContext?: unknown;
      };
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/x-amz-json-1.1" });
        res.end(JSON.stringify(payload));
      };
      try {
        if (op === "GenerateDataKey") {
          const keyId = String(body.KeyId);
          calls.push({ op, keyId });
          const plaintext = randomBytes(32);
          return reply(200, {
            KeyId: keyId,
            Plaintext: plaintext.toString("base64"),
            CiphertextBlob: wrap(
              keyId,
              plaintext,
              body.EncryptionContext,
            ).toString("base64"),
          });
        }
        if (op === "Decrypt") {
          const out = unwrap(
            Buffer.from(String(body.CiphertextBlob), "base64"),
            body.EncryptionContext,
          );
          calls.push({ op, keyId: out.keyId });
          return reply(200, {
            KeyId: out.keyId,
            Plaintext: out.plaintext.toString("base64"),
          });
        }
        if (op === "ReEncrypt") {
          const out = unwrap(
            Buffer.from(String(body.CiphertextBlob), "base64"),
            body.SourceEncryptionContext,
          );
          const keyId = String(body.DestinationKeyId);
          calls.push({ op, keyId });
          return reply(200, {
            KeyId: keyId,
            SourceKeyId: out.keyId,
            CiphertextBlob: wrap(
              keyId,
              out.plaintext,
              body.DestinationEncryptionContext,
            ).toString("base64"),
          });
        }
        return reply(400, { __type: "UnknownOperationException" });
      } catch {
        return reply(400, {
          __type: "InvalidCiphertextException",
          message: "The ciphertext or encryption context is invalid.",
        });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
