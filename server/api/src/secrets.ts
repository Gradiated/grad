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
 * workspace or under another name. `keyId` names the key that sealed a value.
 *
 * Two modes:
 * - local (self-hosted): `GRAD_SECRETS_KEY` seals every value;
 *   `GRAD_SECRETS_KEYS_OLD` stay readable while the key rotates.
 * - KMS (Cloud, `GRAD_SECRETS_KMS_KEY_ID`): envelope encryption. Each value
 *   gets its own data key, wrapped by the AWS KMS key with the workspace and
 *   name as encryption context; only the wrapped key is stored. Rotating to a
 *   new KMS key re-wraps data keys (`reseal`, KMS ReEncrypt) without touching
 *   the ciphertext, and values sealed by a local key move onto KMS the same way.
 */
interface SealedSecret {
  keyId: string;
  nonce: Buffer;
  /** Ciphertext followed by the 16-byte GCM tag. */
  ciphertext: Buffer;
  /** KMS mode: the value's data key, wrapped by the KMS key. */
  wrappedKey?: Buffer | null | undefined;
}

export interface SecretsCipher {
  /** The key new values are sealed with. */
  readonly keyId: string;
  /** KMS mode: values under another key are re-sealed by the maintenance tick. */
  readonly reseals: boolean;
  seal(
    workspaceId: string,
    name: string,
    plaintext: string,
  ): Promise<SealedSecret>;
  open(
    workspaceId: string,
    name: string,
    sealed: SealedSecret,
  ): Promise<string>;
  /** The same value sealed under the current key (KMS: the data key re-wrapped). */
  reseal(
    workspaceId: string,
    name: string,
    sealed: SealedSecret,
  ): Promise<SealedSecret>;
}

/** The slice of AWS KMS the envelope mode needs (src/kms.ts; a fake in tests). */
export interface KeyWrapper {
  generateDataKey(
    keyId: string,
    context: Record<string, string>,
  ): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  unwrap(wrapped: Buffer, context: Record<string, string>): Promise<Buffer>;
  rewrap(
    wrapped: Buffer,
    toKeyId: string,
    context: Record<string, string>,
  ): Promise<Buffer>;
}

const TAG_BYTES = 16;
const KMS_PREFIX = "kms:";

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

const kmsContext = (workspaceId: string, name: string) => ({
  grad_workspace: workspaceId,
  grad_secret: name,
});

const encrypt = (
  key: Buffer,
  workspaceId: string,
  name: string,
  plaintext: string,
) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(workspaceId, name));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  return { nonce, ciphertext };
};

const decrypt = (
  key: Buffer,
  workspaceId: string,
  name: string,
  sealed: SealedSecret,
): string => {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
  decipher.setAAD(aad(workspaceId, name));
  decipher.setAuthTag(sealed.ciphertext.subarray(-TAG_BYTES));

  return Buffer.concat([
    decipher.update(sealed.ciphertext.subarray(0, -TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
};

export const secretsUnavailable = () =>
  unavailable(
    "secrets_unavailable",
    "Workspace secrets are not configured on this server: set GRAD_SECRETS_KEY to 32 random bytes in base64 (openssl rand -base64 32). The compose file and Helm chart generate one.",
  );

/**
 * Returns null when neither `GRAD_SECRETS_KEY` nor a KMS key is set; throws
 * on a malformed key.
 */
export const createSecretsCipher = (options: {
  key?: string | undefined;
  oldKeys?: string | undefined;
  kmsKeyId?: string | undefined;
  kms?: KeyWrapper | undefined;
}): SecretsCipher | null => {
  if (!options.key && !options.kmsKeyId) {
    if (options.oldKeys) {
      throw new Error("GRAD_SECRETS_KEYS_OLD needs GRAD_SECRETS_KEY.");
    }

    return null;
  }

  // Local keys: the sealing key (local mode) or, in KMS mode, the keys
  // older values were sealed with, readable until they are re-sealed.
  const keys = new Map<string, Buffer>();
  const current = options.key
    ? parseKey("GRAD_SECRETS_KEY", options.key)
    : null;
  if (current) keys.set(keyIdOf(current), current);
  for (const old of (options.oldKeys ?? "").split(",")) {
    if (old.trim()) {
      const key = parseKey("GRAD_SECRETS_KEYS_OLD", old);
      keys.set(keyIdOf(key), key);
    }
  }

  const localKey = (name: string, keyId: string): Buffer => {
    const key = keys.get(keyId);
    if (!key) {
      throw new Error(
        `Secret '${name}' was sealed with key ${keyId}, which is neither GRAD_SECRETS_KEY nor in GRAD_SECRETS_KEYS_OLD.`,
      );
    }

    return key;
  };

  const kmsKeyId = options.kmsKeyId;
  if (!kmsKeyId) {
    const key = current as Buffer;
    const keyId = keyIdOf(key);
    const seal = async (ws: string, name: string, plaintext: string) => ({
      keyId,
      ...encrypt(key, ws, name, plaintext),
    });
    const open = async (ws: string, name: string, sealed: SealedSecret) =>
      decrypt(localKey(name, sealed.keyId), ws, name, sealed);

    return {
      keyId,
      reseals: false,
      seal,
      open,
      reseal: async (ws, name, sealed) =>
        seal(ws, name, await open(ws, name, sealed)),
    };
  }

  const kms = options.kms;
  if (!kms) throw new Error("GRAD_SECRETS_KMS_KEY_ID needs a KMS client.");
  const keyId = `${KMS_PREFIX}${kmsKeyId}`;

  const seal = async (ws: string, name: string, plaintext: string) => {
    const dataKey = await kms.generateDataKey(kmsKeyId, kmsContext(ws, name));
    try {
      return {
        keyId,
        wrappedKey: dataKey.wrapped,
        ...encrypt(dataKey.plaintext, ws, name, plaintext),
      };
    } finally {
      dataKey.plaintext.fill(0);
    }
  };

  const open = async (ws: string, name: string, sealed: SealedSecret) => {
    if (!sealed.keyId.startsWith(KMS_PREFIX)) {
      return decrypt(localKey(name, sealed.keyId), ws, name, sealed);
    }
    if (!sealed.wrappedKey) {
      throw new Error(`Secret '${name}' has no wrapped data key.`);
    }
    const dataKey = await kms.unwrap(sealed.wrappedKey, kmsContext(ws, name));
    try {
      return decrypt(dataKey, ws, name, sealed);
    } finally {
      dataKey.fill(0);
    }
  };

  return {
    keyId,
    reseals: true,
    seal,
    open,
    reseal: async (ws, name, sealed) => {
      if (sealed.keyId.startsWith(KMS_PREFIX) && sealed.wrappedKey) {
        return {
          keyId,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          wrappedKey: await kms.rewrap(
            sealed.wrappedKey,
            kmsKeyId,
            kmsContext(ws, name),
          ),
        };
      }

      // A value sealed by a local key: open it and seal it with a data key.
      return seal(ws, name, await open(ws, name, sealed));
    },
  };
};
