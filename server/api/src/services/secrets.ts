import type { Secret } from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { conflict, invalid, notFound } from "../errors.js";
import { assertSecretHost, normaliseAllowedHosts } from "../secret-hosts.js";
import { secretsUnavailable, type SecretsCipher } from "../secrets.js";
import { log } from "../telemetry/log.js";
import type { Page, PageRequest } from "../store/types.js";
import { resumeSource } from "./sources.js";

/** Where a secret is about to be sent: checked against its allowed_hosts. */
export interface SecretUse {
  url: string;
  /** For the error message: "langfuse source", "HF import", ... */
  use: string;
}

/**
 * Workspace secrets (provider keys, HF tokens, logger keys): sealed at rest,
 * revealed only to send to a host the secret allows.
 */
export interface SecretService {
  /** Stores (or replaces) a value; the paused sources that use it resume. */
  set(
    workspaceId: string,
    name: string,
    value: string,
    allowedHosts?: readonly string[] | undefined,
  ): Promise<Secret>;
  get(workspaceId: string, name: string): Promise<Secret>;
  list(workspaceId: string, page: PageRequest): Promise<Page<Secret>>;
  /** 409 secret_in_use while a source uses it. */
  delete(workspaceId: string, name: string): Promise<void>;
  /**
   * KMS mode: re-seals up to `limit` values sealed under another key (a KMS
   * key rotated out, or a local GRAD_SECRETS_KEY being migrated onto KMS);
   * returns how many. A value that fails is logged and retried next pass.
   */
  reseal(limit?: number): Promise<number>;
  /**
   * 422 secret_not_found unless `name` exists (and secrets are configured),
   * 422 secret_host_not_allowed unless it may be sent to `to`.
   */
  require(workspaceId: string, name: string, to: SecretUse): Promise<void>;
  /**
   * Plaintext for a worker claim (HF tokens, provider keys), re-checked
   * against allowed_hosts at claim time. Never log it.
   */
  reveal(workspaceId: string, name: string, to: SecretUse): Promise<string>;
}

export const createSecretService = (deps: AppDependencies): SecretService => {
  const { store, clock } = deps;

  // The re-seal pass's position (by secret id); "" starts a new pass.
  let resealCursor = "";

  const cipher = (): SecretsCipher => {
    if (!deps.secrets) throw secretsUnavailable();

    return deps.secrets;
  };

  const reveal = async (workspaceId: string, name: string, to: SecretUse) => {
    const secret = await store.secrets.get(workspaceId, name);
    const sealed = await store.secrets.getSealed(workspaceId, name);
    if (!secret || !sealed) throw notFound("secret", name);
    assertSecretHost(secret, to.url, to.use);

    return await cipher().open(workspaceId, name, sealed);
  };

  const require = async (workspaceId: string, name: string, to: SecretUse) => {
    cipher();
    const secret = await store.secrets.get(workspaceId, name);
    if (!secret) {
      throw invalid(
        "secret_not_found",
        `No secret named '${name}' in this workspace. Store it first with 'grad secrets set ${name}' (the value is read from stdin).`,
      );
    }
    assertSecretHost(secret, to.url, to.use);
  };

  return {
    set: async (workspaceId, name, value, allowedHosts) => {
      const secret = await store.secrets.put({
        workspaceId,
        name,
        sealed: await cipher().seal(workspaceId, name, value),
        allowedHosts: normaliseAllowedHosts(allowedHosts),
      });
      // A new key is the usual fix for a paused source: resume its users.
      for (const id of await store.sources.usingSecret(workspaceId, name)) {
        await store.transaction(async () => {
          const locked = await store.sources.lock(workspaceId, id);
          if (locked) await resumeSource(store, clock.now(), locked);
        });
      }

      return secret;
    },

    get: async (workspaceId, name) => {
      const secret = await store.secrets.get(workspaceId, name);
      if (!secret) throw notFound("secret", name);

      return secret;
    },

    list: (workspaceId, page) => store.secrets.list(workspaceId, page),

    delete: async (workspaceId, name) => {
      const users = await store.sources.usingSecret(workspaceId, name);
      if (users.length > 0) {
        throw conflict(
          "secret_in_use",
          `Secret '${name}' is used by ${users.length === 1 ? "source" : "sources"} ${users.join(", ")}; remove ${users.length === 1 ? "it" : "them"} first.`,
        );
      }
      if (!(await store.secrets.delete(workspaceId, name))) {
        throw notFound("secret", name);
      }
    },

    reseal: async (limit = 100) => {
      const secrets = deps.secrets;
      if (!secrets?.reseals) return 0;
      const batch = await store.secrets.listSealedNotUnder(
        secrets.keyId,
        resealCursor,
        limit,
      );
      resealCursor = batch.length < limit ? "" : (batch.at(-1)?.id ?? "");
      let done = 0;
      for (const { workspaceId, name, sealed } of batch) {
        try {
          const next = await secrets.reseal(workspaceId, name, sealed);
          if (
            await store.secrets.replaceSealed(
              workspaceId,
              name,
              sealed.keyId,
              next,
            )
          ) {
            done += 1;
          }
        } catch (error) {
          log("error", "could not re-seal a workspace secret", {
            workspace_id: workspaceId,
            secret: name,
            key_id: sealed.keyId,
            error,
          });
        }
      }

      return done;
    },

    require,
    reveal,
  };
};
