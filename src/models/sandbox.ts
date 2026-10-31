export type SandboxStatus = "starting" | "ready" | "busy" | "expired" | "destroyed";

// Resource limits for one sandbox. Each field has a server default and a server
// maximum (config.ts); a request above the maximum is rejected.
export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  // Size of the writable tmpfs mounted at /workspace.
  diskMb: number;
  pids: number;
  ttlSeconds: number;
}

export interface Sandbox {
  id: string;
  status: SandboxStatus;
  limits: SandboxLimits;
  createdAt: Date;
  expiresAt: Date;
  // What the runtime calls this sandbox (the container id). Undefined while starting
  // and after the container is gone. Never shown to callers.
  handle: string | undefined;
  // Number of execs running right now; the sandbox is "busy" while it is above zero.
  activeExecs: number;
}

export type CreateSandboxRequest = Partial<SandboxLimits>;

export interface ExecRequest {
  cmd: string[];
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  // True when the per-exec timeout killed the command.
  timedOut: boolean;
}

// "expired" and "destroyed" both mean the container has been removed; they only
// differ in who did it (the TTL reaper or the caller).
export function isGone(sandbox: Sandbox): boolean {
  return sandbox.status === "expired" || sandbox.status === "destroyed";
}
