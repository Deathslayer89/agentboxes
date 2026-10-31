import { ValidationError } from "../errors.js";
import type { CreateSandboxRequest, ExecRequest } from "../models/sandbox.js";
import { isValidTemplateName } from "../models/template.js";

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
  return req;
}

export function parseExecRequest(body: unknown): ExecRequest {
  const obj = asObject(body);
  const cmd = obj.cmd;
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((arg) => typeof arg === "string")) {
    throw new ValidationError("cmd must be a non-empty array of strings");
  }
  const timeoutMs = optionalPositive(obj, "timeoutMs", true);
  return timeoutMs === undefined ? { cmd } : { cmd, timeoutMs };
}
