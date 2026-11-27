import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  ReEncryptCommand,
} from "@aws-sdk/client-kms";

import type { KeyWrapper } from "../secrets.js";

/**
 * AWS KMS for envelope-encrypted secrets. Credentials and region come from
 * the standard AWS chain (Pod Identity in Cloud); AWS_ENDPOINT_URL_KMS points
 * it elsewhere (tests).
 */
export const createKmsKeyWrapper = (
  options: { region?: string | undefined; client?: KMSClient } = {},
): KeyWrapper => {
  const client =
    options.client ??
    new KMSClient({
      ...(options.region ? { region: options.region } : {}),
      maxAttempts: 3,
    });

  const bytes = (value: Uint8Array | undefined, what: string): Buffer => {
    if (!value) throw new Error(`KMS returned no ${what}.`);

    return Buffer.from(value);
  };

  return {
    generateDataKey: async (keyId, context) => {
      const out = await client.send(
        new GenerateDataKeyCommand({
          KeyId: keyId,
          KeySpec: "AES_256",
          EncryptionContext: context,
        }),
      );

      return {
        plaintext: bytes(out.Plaintext, "data key"),
        wrapped: bytes(out.CiphertextBlob, "wrapped data key"),
      };
    },
    unwrap: async (wrapped, context) =>
      bytes(
        (
          await client.send(
            new DecryptCommand({
              CiphertextBlob: wrapped,
              EncryptionContext: context,
            }),
          )
        ).Plaintext,
        "data key",
      ),
    rewrap: async (wrapped, toKeyId, context) =>
      bytes(
        (
          await client.send(
            new ReEncryptCommand({
              CiphertextBlob: wrapped,
              SourceEncryptionContext: context,
              DestinationKeyId: toKeyId,
              DestinationEncryptionContext: context,
            }),
          )
        ).CiphertextBlob,
        "re-wrapped data key",
      ),
  };
};
