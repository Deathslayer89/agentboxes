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
  // Name of the API key that created it; "local" when auth is off.
  owner: string;
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

/**
 * How the proxy sends one secret: the header (default Authorization) and what goes before the
 * value (default "Bearer " for Authorization, nothing for any other header).
 */
export interface SecretSpec {
  env: string;
  header?: string;
  prefix?: string;
}

export type CreateSandboxRequest = Partial<SandboxLimits> & {
  template?: string;
  // Rules the sandbox may reach through the egress proxy: "pypi.org" (ports 80 and 443), "db.example.com:5432", "*.example.com".
  allowHosts?: string[];
  // host -> the server environment variable holding the secret; a bare name means "Authorization: Bearer <value>".
  secrets?: Record<string, string | SecretSpec>;
};

export interface ExecRequest {
  cmd: string[];
  timeoutMs?: number;
  // Working directory, under /workspace. Defaults to /workspace.
  cwd?: string;
  // Extra environment variables for this command only.
  env?: Record<string, string>;
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
