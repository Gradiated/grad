import { GradError, readEnv } from "./transport.js";
import { GradUsageError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.gradiated.com";

export interface ProfileConfig {
  baseURL?: string | undefined;
  apiKey?: string | undefined;
}

const isNode = (): boolean =>
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";

/** `$XDG_CONFIG_HOME/gradiated/config.json`, else `~/.config/gradiated/config.json` (written by `grad login`). */
export const defaultConfigPath = (): string | undefined => {
  const xdg = readEnv("XDG_CONFIG_HOME");
  if (xdg) return `${xdg.replace(/\/+$/, "")}/gradiated/config.json`;
  const home = readEnv("HOME") ?? readEnv("USERPROFILE");
  return home ? `${home.replace(/[\\/]+$/, "")}/.config/gradiated/config.json` : undefined;
};

/**
 * Reads one profile from the CLI config file. Missing file -> undefined; a
 * malformed file is an error (so a typo never silently drops credentials).
 * Node only: in a browser there is no config file.
 */
export const loadProfile = async (
  path: string | undefined,
  profile: string,
): Promise<ProfileConfig | undefined> => {
  if (!path || !isNode()) return undefined;
  const fs = await import("node:fs/promises");
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw new GradUsageError(`Could not read ${path}: ${(error as Error).message}`, "config_unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GradUsageError(`${path} is not valid JSON; fix it or run \`grad login\` again.`, "config_invalid");
  }
  const profiles = (parsed as { profiles?: Record<string, unknown> } | null)?.profiles;
  const entry = profiles?.[profile];
  if (entry === undefined) return undefined;
  if (typeof entry !== "object" || entry === null) {
    throw new GradUsageError(`Profile '${profile}' in ${path} must be an object.`, "config_invalid");
  }
  const { base_url: baseURL, api_key: apiKey } = entry as { base_url?: unknown; api_key?: unknown };
  return {
    ...(typeof baseURL === "string" && baseURL !== "" ? { baseURL } : {}),
    ...(typeof apiKey === "string" && apiKey !== "" ? { apiKey } : {}),
  };
};

/** Fails fast on a base URL that can never work (no scheme, ftp://, ...). */
export const validateBaseURL = (baseURL: string): void => {
  let parsed: URL | undefined;
  try {
    parsed = new URL(baseURL);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new GradError(`Invalid base URL '${baseURL}': it must be an absolute http(s) URL such as https://api.gradiated.com.`, {
      code: "invalid_base_url",
    });
  }
};

/** The error every SDK and the CLI give when no API key is configured for a remote server. */
export const missingKeyMessage = (baseURL: string): string =>
  `No API key for ${baseURL}: run \`grad login\`, set GRADIATED_API_KEY, or export GRADIATED_PROFILE=local to use a \`grad local up\` stack.`;

/** True when the URL points at this machine (local stacks often run without auth). */
export const isLoopback = (baseURL: string): boolean => {
  let host: string;
  try {
    host = new URL(baseURL).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
};

const warned = new Set<string>();

/** Strips trailing slashes and a trailing `/v1` (the SDK adds it), warning once per URL. */
export const normalizeBaseURL = (baseURL: string, warn = true): string => {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  if (!trimmed.endsWith("/v1")) return trimmed;
  if (warn && !warned.has(trimmed)) {
    warned.add(trimmed);
    console.warn(`grad: base URL '${trimmed}' ends in /v1; the SDK adds /v1 itself, so it was dropped.`);
  }
  return trimmed.slice(0, -3);
};
