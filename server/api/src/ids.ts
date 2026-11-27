import { randomBytes } from "node:crypto";

/** Prefixed random identifier, e.g. `run_3f9c0a1b2c3d4e5f60718293`. */
export const newId = (prefix: string): string =>
  `${prefix}_${randomBytes(12).toString("hex")}`;

/** URL-safe secret token with 256 bits of entropy. */
export const newSecretToken = (): string =>
  randomBytes(32).toString("base64url");
