import type { LoggerSpec, SourceProviderKind } from "./contracts.js";
import { invalid } from "./errors.js";

/**
 * Where a workspace secret may be sent. Each secret carries `allowed_hosts`,
 * set with its value (so changing it needs `secrets:write`), and every use
 * (a source, an HF import, a run logger) sends it only to one of those hosts.
 * Without the binding, a key that may create sources could point one at a
 * host it controls and receive any secret's plaintext.
 */

/** A provider's public API host when a source gives none. */
export const PROVIDER_DEFAULT_HOSTS: Readonly<
  Partial<Record<SourceProviderKind, string>>
> = {
  langfuse: "https://cloud.langfuse.com",
  langsmith: "https://api.smith.langchain.com",
  braintrust: "https://api.braintrust.dev",
  posthog: "https://us.posthog.com",
};

export const HF_HOST = "huggingface.co";
export const WANDB_DEFAULT_HOST = "https://api.wandb.ai";

/** Where a run logger sends its secret: the W&B host or the MLflow server. */
export const loggerUrl = (logger: LoggerSpec): string =>
  logger.kind === "wandb"
    ? (logger.host ?? WANDB_DEFAULT_HOST)
    : logger.tracking_uri;

/**
 * `allowed_hosts` of a secret set without one: the public hosts of the
 * providers grad talks to. A secret for a self-hosted tool (Phoenix, a
 * self-hosted Langfuse, MLflow, W&B server) must name its host.
 */
export const DEFAULT_SECRET_HOSTS: readonly string[] = [
  "cloud.langfuse.com",
  "us.cloud.langfuse.com",
  "api.smith.langchain.com",
  "eu.api.smith.langchain.com",
  "api.braintrust.dev",
  "us.posthog.com",
  "eu.posthog.com",
  "app.phoenix.arize.com",
  HF_HOST,
  "api.wandb.ai",
];

const HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** `host[:port]` of a URL or bare host, lowercased; null when it is neither. */
export const hostOf = (value: string): string | null => {
  const raw = value.trim();
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (!raw.includes("://") && (url.pathname !== "/" || url.search)) {
      return null;
    }
    const host = url.host.toLowerCase();

    return HOST_RE.test(host) || /^\[[0-9a-f:.]+\](:\d+)?$/.test(host)
      ? host
      : null;
  } catch {
    return null;
  }
};

/** Normalised, de-duplicated `allowed_hosts`; 422 for an entry that is no host. */
export const normaliseAllowedHosts = (
  hosts: readonly string[] | undefined,
): string[] => {
  if (hosts === undefined) return [...DEFAULT_SECRET_HOSTS];
  const out = new Set<string>();
  for (const value of hosts) {
    const host = hostOf(value);
    if (host === null) {
      throw invalid(
        "secret_host_invalid",
        `allowed_hosts entries are hosts such as 'langfuse.example.com' or 'mlflow.internal:5000' (or URLs); '${value}' is neither.`,
      );
    }
    out.add(host);
  }

  return [...out].sort();
};

/** 422 secret_host_not_allowed unless `secret` may be sent to `url`'s host. */
export const assertSecretHost = (
  secret: { name: string; allowed_hosts: readonly string[] },
  url: string,
  use: string,
): void => {
  const host = hostOf(url);
  if (host !== null && secret.allowed_hosts.includes(host)) return;
  throw invalid(
    "secret_host_not_allowed",
    `Secret '${secret.name}' may only be sent to ${secret.allowed_hosts.length > 0 ? secret.allowed_hosts.join(", ") : "no host"}, not to ${host ?? url} (${use}). Someone with secrets:write can allow it: 'grad secrets set ${secret.name} --allowed-host ${host ?? "HOST"}'.`,
  );
};
