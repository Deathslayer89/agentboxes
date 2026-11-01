import { isIP } from "node:net";
import { ValidationError } from "../errors.js";
import type { CreateSandboxRequest, ExecRequest, SecretSpec } from "../models/sandbox.js";
import { isValidTemplateName } from "../models/template.js";

// A DNS name, optionally starting with "*." for subdomains, or an IP literal.
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SHELL_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
// Headers the proxy itself owns; a secret may not be sent in one of these.
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "proxy-authorization"]);
const PREFIX = /^[\x20-\x7e]{0,64}$/;
const MAX_ENV = 100;
const MAX_HOSTS = 100;

function isHost(value: unknown, wildcard: boolean): value is string {
  return typeof value === "string" && value.length <= 253 && (isIP(value) !== 0 || (HOST.test(value) && (wildcard || !value.startsWith("*."))));
}

// "host" or "host:port" (names and IPv4 only), lowercased; undefined when malformed.
function parseHostRule(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(.+):(\d{1,5})$/.exec(value);
  if (match === null || isIP(value) === 6) return isHost(value, true) ? value.toLowerCase() : undefined;
  const port = Number(match[2]);
  return isHost(match[1], true) && port >= 1 && port <= 65535 ? `${match[1].toLowerCase()}:${port}` : undefined;
}

// A bare environment variable name, or { env, header?, prefix? }.
function isSecretSpec(value: unknown): value is string | SecretSpec {
  if (typeof value === "string") return ENV_NAME.test(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { env, header, prefix } = value as Record<string, unknown>;
  if (typeof env !== "string" || !ENV_NAME.test(env)) return false;
  if (header !== undefined && (typeof header !== "string" || !HEADER_NAME.test(header) || RESERVED_HEADERS.has(header.toLowerCase()))) return false;
  return prefix === undefined || (typeof prefix === "string" && PREFIX.test(prefix));
}

// Shape checks for untrusted JSON bodies. Policy checks (server maximums) live in SandboxService.

function asObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new ValidationError("body must be a JSON object");
  return body as Record<string, unknown>;
}

function optionalPositive(obj: Record<string, unknown>, key: string, integer: boolean): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  const ok = typeof value === "number" && Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value));
  if (!ok) throw new ValidationError(`${key} must be a positive ${integer ? "integer" : "number"}`);
  return value;
}

export function parseCreateRequest(body: unknown): CreateSandboxRequest {
  const obj = asObject(body);
  const req: CreateSandboxRequest = {};
  for (const key of ["memoryMb", "diskMb", "pids", "ttlSeconds"] as const) {
    const value = optionalPositive(obj, key, true);
    if (value !== undefined) req[key] = value;
  }
  // cpus may be fractional (0.5 is a valid Docker cpu share).
  const cpus = optionalPositive(obj, "cpus", false);
  if (cpus !== undefined) req.cpus = cpus;
  if (obj.template !== undefined) {
    if (typeof obj.template !== "string" || !isValidTemplateName(obj.template)) {
      throw new ValidationError("template must be lowercase letters, digits, dot, dash or underscore");
    }
    req.template = obj.template;
  }
  if (obj.allowHosts !== undefined) {
    const hosts = obj.allowHosts;
    const rules = Array.isArray(hosts) && hosts.length <= MAX_HOSTS ? hosts.map(parseHostRule) : undefined;
    if (rules === undefined || rules.some((rule) => rule === undefined)) {
      throw new ValidationError(`allowHosts must be an array of up to ${MAX_HOSTS} rules like "pypi.org", "*.example.com" or "db.example.com:5432"`);
    }
    req.allowHosts = rules as string[];
  }
  if (obj.secrets !== undefined) {
    const secrets = obj.secrets;
    if (typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) throw new ValidationError("secrets must be an object of host to secret");
    const entries = Object.entries(secrets as Record<string, unknown>);
    if (entries.length > MAX_HOSTS || !entries.every(([host, spec]) => isHost(host, false) && isSecretSpec(spec))) {
      throw new ValidationError('secrets must map host names to environment variable names, for example { "api.openai.com": "OPENAI_API_KEY" }, or to { "env": "ANTHROPIC_API_KEY", "header": "x-api-key" }');
    }
    req.secrets = Object.fromEntries(entries.map(([host, spec]) => [host.toLowerCase(), spec as string | SecretSpec]));
  }
  return req;
}

export function parseExtendRequest(body: unknown): number | undefined {
  return optionalPositive(asObject(body), "ttlSeconds", true);
}

export function parseExecRequest(body: unknown): ExecRequest {
  const obj = asObject(body);
  const cmd = obj.cmd;
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((arg) => typeof arg === "string")) {
    throw new ValidationError("cmd must be a non-empty array of strings");
  }
  const req: ExecRequest = { cmd };
  const timeoutMs = optionalPositive(obj, "timeoutMs", true);
  if (timeoutMs !== undefined) req.timeoutMs = timeoutMs;
  if (obj.cwd !== undefined) {
    if (typeof obj.cwd !== "string" || obj.cwd === "") throw new ValidationError("cwd must be a non-empty string");
    req.cwd = obj.cwd;
  }
  if (obj.env !== undefined) {
    const env = obj.env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) throw new ValidationError("env must be an object of variable name to string value");
    const entries = Object.entries(env as Record<string, unknown>);
    if (entries.length > MAX_ENV || !entries.every(([name, value]) => SHELL_VAR.test(name) && typeof value === "string" && !value.includes("\0"))) {
      throw new ValidationError(`env must map up to ${MAX_ENV} variable names to string values`);
    }
    req.env = env as Record<string, string>;
  }
  return req;
}
