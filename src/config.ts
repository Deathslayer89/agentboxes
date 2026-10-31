import type { SandboxLimits } from "./models/sandbox.js";

export interface Config {
  port: number;
  // Interface to listen on. Without an API key the server only binds to loopback.
  host: string;
  // A1: shared bearer token. Undefined means auth is off and host is forced to 127.0.0.1.
  apiKey: string | undefined;
  // Image every sandbox starts from. Templates (Day 2) build FROM this.
  image: string;
  // Limits a sandbox gets when the request does not say otherwise.
  defaults: SandboxLimits;
  // Hard ceiling per sandbox so one caller cannot take the whole machine.
  maximums: SandboxLimits;
  defaultExecTimeoutMs: number;
  maxExecTimeoutMs: number;
  // Per stream (stdout, stderr) cap on captured output per exec.
  maxOutputBytes: number;
  // Cap on live sandboxes across all callers.
  maxSandboxes: number;
  reaperIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
    return value;
  };

  const apiKey = env.AGENTBOX_API_KEY || undefined;
  const config: Config = {
    port: num("PORT", 7788),
    host: apiKey === undefined ? "127.0.0.1" : env.HOST || "0.0.0.0",
    apiKey,
    image: env.AGENTBOX_IMAGE ?? "python:3.12-slim",
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
    maxExecTimeoutMs: num("MAX_EXEC_TIMEOUT_MS", 300_000),
    maxOutputBytes: num("MAX_OUTPUT_BYTES", 1_048_576),
    maxSandboxes: num("MAX_SANDBOXES", 20),
    reaperIntervalMs: num("REAPER_INTERVAL_MS", 10_000),
  };

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
