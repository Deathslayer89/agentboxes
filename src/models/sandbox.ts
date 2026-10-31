export type SandboxStatus = "starting" | "ready" | "busy" | "expired" | "destroyed";

/**
 * Resource limits for one sandbox. Each field has a server default and a server
 * maximum (config.ts); a request above the maximum is rejected.
 */
export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  // Size of the writable tmpfs mounted at /workspace. It is memory, and is added to the cgroup limit.
  diskMb: number;
  pids: number;
  ttlSeconds: number;
}

// Where the container came from and how long create() took to make the sandbox ready.
export interface Startup {
  source: "pool" | "cold";
  ms: number;
}

// What a sandbox may reach. Secret hosts are listed by name only; the values never leave the server and the proxy.
export interface SandboxNetwork {
  allowHosts: string[];
  secretHosts: string[];
}

export interface Sandbox {
  id: string;
  status: SandboxStatus;
  template: string;
  limits: SandboxLimits;
  // Undefined means no network at all.
  network: SandboxNetwork | undefined;
  startup: Startup;
  createdAt: Date;
  expiresAt: Date;
  /**
   * What the runtime calls this sandbox (the container id). Undefined while starting
   * and after the container is gone. Never shown to callers.
   */
  handle: string | undefined;
  // Number of execs running right now; the sandbox is "busy" while it is above zero.
  activeExecs: number;
}

export type CreateSandboxRequest = Partial<SandboxLimits> & {
  template?: string;
  // Host names the sandbox may reach through the egress proxy. "*.example.com" matches subdomains.
  allowHosts?: string[];
  // host -> name of a server environment variable whose value the proxy sends as "Authorization: Bearer <value>".
  secrets?: Record<string, string>;
};

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
  // True when stdout or stderr went over MAX_OUTPUT_BYTES and was cut.
  truncated: boolean;
}

/**
 * "expired" and "destroyed" both mean the container has been removed; they only
 * differ in who did it (the TTL reaper or the caller).
 */
export function isGone(sandbox: Sandbox): boolean {
  return sandbox.status === "expired" || sandbox.status === "destroyed";
}
