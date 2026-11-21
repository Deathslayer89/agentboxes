import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ApiKey } from "./models/apiKey.js";
import type { SandboxLimits, SecretSpec } from "./models/sandbox.js";
import { DEFAULT_TEMPLATE, isValidTemplateName } from "./models/template.js";

// The database path a project used before the default moved under the user's data directory.
export const LEGACY_DB_PATH = "data/agentbox.db";

// The path of the pid file, next to the database, so it resolves from the same AGENTBOX_DB the server used.
export function pidPathFor(dbPath: string): string {
  return join(dirname(dbPath), "agentbox.pid");
}

// Whether a process command line (from /proc/<pid>/cmdline, NULs replaced by spaces) is an agentbox server, matched by one of its entry points rather than a loose substring so a reused pid for another node process is not mistaken for one.
export function looksLikeAgentbox(cmdline: string): boolean {
  return /(?:^|[/\\\s])(?:src[/\\]main\.ts|dist[/\\]src[/\\]main\.js|bin[/\\]agentbox\.js\s+serve)(?:\s|$)|(?:^|\/)agentbox\s+serve/.test(cmdline);
}

/**
 * Where the SQLite file lives: AGENTBOX_DB when set, else the legacy ./data/agentbox.db when it already exists
 * (so an existing install keeps its data), else the per-user default under XDG_DATA_HOME or ~/.local/share.
 */
export function pickDbPath(env: NodeJS.ProcessEnv, legacyExists: boolean): { path: string; legacy: boolean } {
  if (env.AGENTBOX_DB) return { path: env.AGENTBOX_DB, legacy: false };
  if (legacyExists) return { path: LEGACY_DB_PATH, legacy: true };
  const base = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return { path: join(base, "agentbox", "agentbox.db"), legacy: false };
}

// Headers the proxy owns; a configured secret may not be sent in one of these.
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "proxy-authorization"]);

// A secret resolved from AGENTBOX_SECRETS: the header and value the proxy sends, the source variable name for messages, and the API key names allowed to use it.
export interface ConfiguredSecret {
  header: string;
  value: string;
  env: string;
  keys?: string[];
}

export interface Config {
  port: number;
  // Interface to listen on. Loopback unless HOST says otherwise; anything else needs an API key.
  host: string;
  // Bearer tokens and their per-key limits. Empty means auth is off, which is only allowed on loopback.
  apiKeys: ApiKey[];
  // Names of the API keys allowed to see server-global stats and the host's resource use. Empty when auth is off.
  adminKeys: string[];
  // Image every sandbox starts from. Templates build FROM this.
  image: string;
  // "auto" picks runsc-kvm when registered and runsc otherwise; "firecracker" uses microVMs on a KVM host. Never runc.
  runtime: string;
  // Limits a sandbox gets when the request does not say otherwise.
  defaults: SandboxLimits;
  // Hard ceiling per sandbox so one caller cannot take the whole machine.
  maximums: SandboxLimits;
  defaultExecTimeoutMs: number;
  maxExecTimeoutMs: number;
  // Per stream (stdout, stderr) cap on captured output per exec.
  maxOutputBytes: number;
  // Largest file the files API will write or read.
  maxFileBytes: number;
  // Largest tar archive the archive API will accept or produce.
  maxArchiveBytes: number;
  // Cap on live sandboxes across all callers. Containers waiting in the warm pool do not count.
  maxSandboxes: number;
  // Absolute maximum age of a sandbox from creation, in seconds; extend cannot push it past this. 0 means no cap.
  maxLifetimeSeconds: number;
  // Warm pool size per template, for example { default: 3, "data-science": 2 }. 0 turns a pool off.
  poolSizes: Record<string, number>;
  reaperIntervalMs: number;
  // Secret bindings the proxy may inject, by host, resolved at load from AGENTBOX_SECRETS and the named environment variables. A create request names hosts from this map; it cannot name an arbitrary variable.
  secrets: Record<string, ConfiguredSecret>;
  // SQLite file for sandbox records and settings, so they survive a server restart.
  dbPath: string;
  // True when dbPath fell back to the legacy ./data/agentbox.db because it exists and AGENTBOX_DB is unset.
  dbPathIsLegacy: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
    return value;
  };

  const apiKeys = parseApiKeys(env.AGENTBOX_API_KEY, env.AGENTBOX_API_KEYS);
  const adminKeys = parseAdminKeys(env.AGENTBOX_ADMIN_KEYS, apiKeys);
  const db = pickDbPath(env, existsSync(LEGACY_DB_PATH));
  const host = env.HOST || "127.0.0.1";
  if (apiKeys.length === 0 && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`HOST=${host} would expose the server without an API key; set AGENTBOX_API_KEY first`);
  }
  const config: Config = {
    port: num("PORT", 7788),
    host,
    apiKeys,
    adminKeys,
    image: env.AGENTBOX_IMAGE ?? "python:3.12-slim",
    runtime: env.AGENTBOX_RUNTIME || "auto",
    defaults: {
      memoryMb: num("DEFAULT_MEMORY_MB", 512),
      cpus: num("DEFAULT_CPUS", 1),
      diskMb: num("DEFAULT_DISK_MB", 1024),
      pids: num("DEFAULT_PIDS", 256),
      ttlSeconds: num("DEFAULT_TTL_SECONDS", 600),
    },
    maximums: {
      memoryMb: num("MAX_MEMORY_MB", 4096),
      cpus: num("MAX_CPUS", 4),
      diskMb: num("MAX_DISK_MB", 4096),
      pids: num("MAX_PIDS", 1024),
      ttlSeconds: num("MAX_TTL_SECONDS", 3600),
    },
    defaultExecTimeoutMs: num("DEFAULT_EXEC_TIMEOUT_MS", 30_000),
    maxExecTimeoutMs: num("MAX_EXEC_TIMEOUT_MS", 1_800_000),
    maxOutputBytes: num("MAX_OUTPUT_BYTES", 1_048_576),
    maxFileBytes: num("MAX_FILE_BYTES", 8 * 1_048_576),
    maxArchiveBytes: num("MAX_ARCHIVE_BYTES", 256 * 1_048_576),
    maxSandboxes: num("MAX_SANDBOXES", 20),
    maxLifetimeSeconds: nonNegativeInt(env.MAX_LIFETIME_SECONDS, "MAX_LIFETIME_SECONDS", 86_400),
    poolSizes: parsePoolSizes(env.POOL_SIZES),
    reaperIntervalMs: num("REAPER_INTERVAL_MS", 10_000),
    secrets: parseSecrets(env),
    dbPath: db.path,
    dbPathIsLegacy: db.legacy,
  };

  if (config.runtime !== "auto" && config.runtime !== "firecracker" && !/^runsc(-[a-z0-9]+)?$/.test(config.runtime)) {
    throw new Error(`AGENTBOX_RUNTIME must be auto, firecracker, runsc or a runsc variant such as runsc-kvm, got "${config.runtime}"`);
  }
  // A default above its maximum would make every plain create() fail; catch that at boot.
  for (const key of Object.keys(config.maximums) as (keyof SandboxLimits)[]) {
    if (config.defaults[key] > config.maximums[key]) {
      throw new Error(`default ${key} (${config.defaults[key]}) is above its maximum (${config.maximums[key]})`);
    }
  }
  if (config.defaultExecTimeoutMs > config.maxExecTimeoutMs) {
    throw new Error("DEFAULT_EXEC_TIMEOUT_MS is above MAX_EXEC_TIMEOUT_MS");
  }
  // A secret bound to a key name that is not configured would silently be usable by no one; catch that at boot.
  const configuredKeyNames = new Set(config.apiKeys.map((key) => key.name));
  for (const [host, secret] of Object.entries(config.secrets)) {
    for (const name of secret.keys ?? []) {
      if (!configuredKeyNames.has(name)) throw new Error(`AGENTBOX_SECRETS for ${host} names key "${name}", which is not a configured API key`);
    }
  }
  // A lifetime cap below the default TTL would make every plain create() expire before its own deadline.
  if (config.maxLifetimeSeconds !== 0 && config.maxLifetimeSeconds < config.defaults.ttlSeconds) {
    throw new Error(`MAX_LIFETIME_SECONDS (${config.maxLifetimeSeconds}) must be 0 or at least DEFAULT_TTL_SECONDS (${config.defaults.ttlSeconds})`);
  }
  return config;
}

/**
 * AGENTBOX_API_KEY is the key named "default". AGENTBOX_API_KEYS adds more as
 * "name:key[:maxSandboxes[:maxMemoryMb]]" entries separated by commas.
 */
export function parseApiKeys(single: string | undefined, list: string | undefined): ApiKey[] {
  const keys: ApiKey[] = [];
  if (single) keys.push({ name: "default", key: single });
  for (const entry of (list ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const [name = "", key = "", sandboxes, memory] = entry.split(":");
    const limit = (raw: string | undefined, what: string): number | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) throw new Error(`AGENTBOX_API_KEYS entry "${name}": ${what} must be a positive integer`);
      return value;
    };
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || key === "") {
      throw new Error(`AGENTBOX_API_KEYS entry "${entry}" must look like name:key[:maxSandboxes[:maxMemoryMb]]`);
    }
    const apiKey: ApiKey = { name, key };
    const maxSandboxes = limit(sandboxes, "maxSandboxes");
    const maxMemoryMb = limit(memory, "maxMemoryMb");
    if (maxSandboxes !== undefined) apiKey.maxSandboxes = maxSandboxes;
    if (maxMemoryMb !== undefined) apiKey.maxMemoryMb = maxMemoryMb;
    keys.push(apiKey);
  }
  const names = keys.map((k) => k.name);
  if (new Set(names).size !== names.length) throw new Error("API key names must be unique");
  return keys;
}

// "default:3,data-science:2" -> { default: 3, "data-science": 2 }. Unset means { default: 3 }.
export function parsePoolSizes(raw: string | undefined): Record<string, number> {
  if (raw === undefined || raw.trim() === "") return { [DEFAULT_TEMPLATE]: 3 };
  const sizes: Record<string, number> = {};
  for (const entry of raw.split(",")) {
    const [name = "", count = ""] = entry.trim().split(":");
    const size = Number(count);
    if (!isValidTemplateName(name) || count === "" || !Number.isInteger(size) || size < 0) {
      throw new Error(`POOL_SIZES entry "${entry.trim()}" must look like name:count, for example default:3`);
    }
    sizes[name] = size;
  }
  return sizes;
}

/**
 * Resolves AGENTBOX_SECRETS, a JSON object of host to secret, into the header and value the proxy sends.
 * A secret is `"ENV_NAME"` (sent as `Authorization: Bearer <value>`) or `{ env, header?, prefix? }`. The value
 * is read from the named environment variable at load, so only the operator decides which variable goes to which host.
 */
function parseSecrets(env: NodeJS.ProcessEnv): Record<string, ConfiguredSecret> {
  const raw = env.AGENTBOX_SECRETS;
  if (raw === undefined || raw === "") return {};
  let spec: unknown;
  try {
    spec = JSON.parse(raw);
  } catch {
    throw new Error('AGENTBOX_SECRETS must be JSON, for example {"api.openai.com":"OPENAI_API_KEY"}');
  }
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error("AGENTBOX_SECRETS must be a JSON object of host to secret");
  }
  const secrets: Record<string, ConfiguredSecret> = {};
  for (const [host, entry] of Object.entries(spec as Record<string, unknown>)) {
    const def: SecretSpec = typeof entry === "string" ? { env: entry } : (entry as SecretSpec);
    if (typeof def.env !== "string" || def.env === "") throw new Error(`AGENTBOX_SECRETS: ${host} must name an environment variable`);
    const value = env[def.env];
    if (value === undefined || value === "") throw new Error(`AGENTBOX_SECRETS: ${def.env} for ${host} is not set in the environment`);
    const header = typeof def.header === "string" ? def.header : "Authorization";
    if (RESERVED_HEADERS.has(header.toLowerCase())) throw new Error(`AGENTBOX_SECRETS: ${host} may not use the ${header} header`);
    const prefix = typeof def.prefix === "string" ? def.prefix : header.toLowerCase() === "authorization" ? "Bearer " : "";
    let keys: string[] | undefined;
    if (def.keys !== undefined) {
      if (!Array.isArray(def.keys) || !def.keys.every((k) => typeof k === "string" && k !== "")) throw new Error(`AGENTBOX_SECRETS: ${host} keys must be an array of API key names`);
      keys = def.keys;
    }
    secrets[host.toLowerCase()] = { header, value: prefix + value, env: def.env, ...(keys !== undefined ? { keys } : {}) };
  }
  return secrets;
}

// A whole number that may be zero (zero disables the limit), from `name`, or the fallback when unset.
function nonNegativeInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

/**
 * Names of the API keys that may see server-global stats and the host's resource use, from AGENTBOX_ADMIN_KEYS
 * (comma-separated key names). When unset, the key named "default" is admin, so a single-key install is unchanged.
 * A name that matches no configured key is a startup error.
 */
function parseAdminKeys(raw: string | undefined, apiKeys: ApiKey[]): string[] {
  const names = new Set(apiKeys.map((key) => key.name));
  if (raw === undefined || raw === "") return names.has("default") ? ["default"] : [];
  const admins = raw.split(",").map((name) => name.trim()).filter((name) => name !== "");
  for (const name of admins) {
    if (!names.has(name)) throw new Error(`AGENTBOX_ADMIN_KEYS names "${name}", which is not a configured API key`);
  }
  return admins;
}
