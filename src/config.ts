import type { ApiKey } from "./models/apiKey.js";
import type { SandboxLimits } from "./models/sandbox.js";
import { DEFAULT_TEMPLATE, isValidTemplateName } from "./models/template.js";

export interface Config {
  port: number;
  // Interface to listen on. Loopback unless HOST says otherwise; anything else needs an API key.
  host: string;
  // Bearer tokens and their per-key limits. Empty means auth is off, which is only allowed on loopback.
  apiKeys: ApiKey[];
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
  // Warm pool size per template, for example { default: 3, "data-science": 2 }. 0 turns a pool off.
  poolSizes: Record<string, number>;
  reaperIntervalMs: number;
  // Where `secrets: { host: ENV_NAME }` values are read from. Never passed into a sandbox.
  secretsEnv: NodeJS.ProcessEnv;
  // SQLite file for sandbox records and settings, so they survive a server restart.
  dbPath: string;
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
  const host = env.HOST || "127.0.0.1";
  if (apiKeys.length === 0 && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`HOST=${host} would expose the server without an API key; set AGENTBOX_API_KEY first`);
  }
  const config: Config = {
    port: num("PORT", 7788),
    host,
    apiKeys,
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
    poolSizes: parsePoolSizes(env.POOL_SIZES),
    reaperIntervalMs: num("REAPER_INTERVAL_MS", 10_000),
    secretsEnv: env,
    dbPath: env.AGENTBOX_DB || "data/agentbox.db",
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
