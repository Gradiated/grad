import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { unavailable } from "./errors.js";

/**
 * Workspace secrets at rest: AES-256-GCM with a random 96-bit nonce per value
 * and AAD = workspace id + name, so a ciphertext can't be replayed into another
 * workspace or under another name. `key_id` names the key that sealed a value,
 * so `GRAD_SECRETS_KEY` can rotate while `GRAD_SECRETS_KEYS_OLD` stays readable.
 */
export interface SealedSecret {
  keyId: string;
  nonce: Buffer;
  /** Ciphertext followed by the 16-byte GCM tag. */
  ciphertext: Buffer;
}

export interface SecretsCipher {
  readonly keyId: string;
  seal(workspaceId: string, name: string, plaintext: string): SealedSecret;
  open(workspaceId: string, name: string, sealed: SealedSecret): string;
}

const TAG_BYTES = 16;

const parseKey = (variable: string, value: string): Buffer => {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32 || key.toString("base64") !== value.trim()) {
    throw new Error(
      `${variable} must be 32 random bytes in base64 (for example: openssl rand -base64 32).`,
    );
  }

  return key;
};

const keyIdOf = (key: Buffer): string =>
  createHash("sha256")
    .update("grad-secrets-key:")
    .update(key)
    .digest("hex")
    .slice(0, 16);

const aad = (workspaceId: string, name: string): Buffer =>
  Buffer.from(`${workspaceId}\u0000${name}`, "utf8");

export const secretsUnavailable = () =>
  unavailable(
    "secrets_unavailable",
    "Workspace secrets are not configured on this server: set GRAD_SECRETS_KEY to 32 random bytes in base64 (openssl rand -base64 32). The compose file and Helm chart generate one.",
  );

/** Returns null when `GRAD_SECRETS_KEY` is unset; throws on a malformed key. */
export const createSecretsCipher = (options: {
  key?: string | undefined;
  oldKeys?: string | undefined;
}): SecretsCipher | null => {
  if (!options.key) {
    if (options.oldKeys) {
      throw new Error("GRAD_SECRETS_KEYS_OLD needs GRAD_SECRETS_KEY.");
    }

    return null;
  }

  const current = parseKey("GRAD_SECRETS_KEY", options.key);
  const keys = new Map<string, Buffer>([[keyIdOf(current), current]]);
  for (const old of (options.oldKeys ?? "").split(",")) {
    if (old.trim()) {
      const key = parseKey("GRAD_SECRETS_KEYS_OLD", old);
      keys.set(keyIdOf(key), key);
    }
  }

  const keyId = keyIdOf(current);

  return {
    keyId,
    seal: (workspaceId, name, plaintext) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", current, nonce);
      cipher.setAAD(aad(workspaceId, name));
      const body = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]);

      return { keyId, nonce, ciphertext: body };
    },
    open: (workspaceId, name, sealed) => {
      const key = keys.get(sealed.keyId);
      if (!key) {
        throw new Error(
          `Secret '${name}' was sealed with key ${sealed.keyId}, which is neither GRAD_SECRETS_KEY nor in GRAD_SECRETS_KEYS_OLD.`,
        );
      }

      const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
      decipher.setAAD(aad(workspaceId, name));
      decipher.setAuthTag(sealed.ciphertext.subarray(-TAG_BYTES));

      return Buffer.concat([
        decipher.update(sealed.ciphertext.subarray(0, -TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
};
