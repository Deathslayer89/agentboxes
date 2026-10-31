import type { ExecResult, SandboxLimits } from "../models/sandbox.js";

// Receives output chunks as they arrive, before the command finishes.
export type OutputListener = (stream: "stdout" | "stderr", chunk: Buffer) => void;

// What the egress proxy enforces for one sandbox. Secret values are full header values, for example "Bearer sk-...".
export interface EgressPolicy {
  allowHosts: string[];
  secrets: Record<string, string>;
}

export interface DeniedRequest {
  at: string;
  method: string;
  host: string;
  port: number;
  reason: string;
}

// Per-command settings the service has already validated.
export interface ExecOptions {
  timeoutMs: number;
  // Absolute, under /workspace.
  cwd: string;
  env: Record<string, string>;
}

/**
 * What the service needs from an isolation backend. gVisor on Docker is the only
 * implementation in v0.1; Firecracker can be added later behind the same interface.
 */
export interface SandboxRuntime {
  /**
   * Verify the backend is usable (for example runsc is registered) and pull the base
   * image if needed. Throws RuntimeUnavailableError. Called once at startup.
   */
  init(): Promise<void>;

/**
   * Start an isolated container from `image` for a sandbox. Returns an opaque handle (the container id).
   * Without `egress` the container has no network at all; with it, only the egress proxy is reachable.
   */
  start(sandboxId: string, limits: SandboxLimits, image: string, egress?: EgressPolicy): Promise<string>;

  // Outbound requests the proxy refused for this sandbox. Empty for a sandbox without a network.
  egressLog(sandboxId: string): Promise<DeniedRequest[]>;

  /**
   * Run one command inside the sandbox and wait for it. Must kill it at options.timeoutMs.
   * When onOutput is given, every chunk is passed to it as soon as it arrives.
   */
  exec(handle: string, cmd: string[], options: ExecOptions, onOutput?: OutputListener): Promise<ExecResult>;

  /**
   * Write a file inside the sandbox, creating parent directories. `path` is absolute
   * and already checked to be under /workspace by the service.
   */
  writeFile(handle: string, path: string, data: Buffer): Promise<void>;

  // Read a file from inside the sandbox. Throws NotFoundError if it does not exist.
  readFile(handle: string, path: string): Promise<Buffer>;

  // Stop and remove the container. Must not fail if it is already gone.
  destroy(handle: string): Promise<void>;

  /**
   * Every container this backend created that still exists, so the reaper can find
   * orphans (containers the server no longer knows about, for example after a restart).
   */
  listManaged(): Promise<Array<{ sandboxId: string; handle: string }>>;

  // Stop anything the backend runs for itself, such as the egress proxy. Called once at shutdown.
  shutdown(): Promise<void>;
}
