import type { ExecResult, SandboxLimits } from "../models/sandbox.js";

// Receives output chunks as they arrive, before the command finishes.
export type OutputListener = (stream: "stdout" | "stderr", chunk: Buffer) => void;

// One header the proxy sets on every request to a secret host. The value is complete, for example "Bearer sk-...".
export interface SecretHeader {
  header: string;
  value: string;
}

// What the egress proxy enforces for one sandbox. Rules are "host" (ports 80 and 443) or "host:port".
export interface EgressPolicy {
  allowHosts: string[];
  secrets: Record<string, SecretHeader>;
}

export interface DeniedRequest {
  at: string;
  method: string;
  host: string;
  port: number;
  reason: string;
}

// What one sandbox uses right now. CPU percent needs two samples, so the first report after a sandbox appears has none.
export interface SandboxUsage {
  cpuPercent: number | undefined;
  memoryMb: number;
}

// Per-command settings the service has already validated.
export interface ExecOptions {
  timeoutMs: number;
  // Absolute, under /workspace.
  cwd: string;
  env: Record<string, string>;
  // When aborted, the command is killed; the sandbox stays.
  signal?: AbortSignal;
}

// The client's result plus `lost`: true when the command took the whole sandbox down, so the service must mark it destroyed.
export interface RuntimeExecResult extends ExecResult {
  lost: boolean;
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
  exec(handle: string, cmd: string[], options: ExecOptions, onOutput?: OutputListener): Promise<RuntimeExecResult>;

  /**
   * Write a file inside the sandbox, creating parent directories. `path` is absolute
   * and already checked to be under /workspace by the service.
   */
  writeFile(handle: string, path: string, data: Buffer): Promise<void>;

  // Read a file from inside the sandbox. Throws NotFoundError if it does not exist.
  readFile(handle: string, path: string): Promise<Buffer>;

  // Unpack a tar archive into `dir`, creating it. `dir` is absolute and under /workspace.
  putArchive(handle: string, dir: string, tar: Buffer): Promise<void>;

  // Pack `dir` as a tar archive. Throws NotFoundError if it does not exist.
  getArchive(handle: string, dir: string): Promise<Buffer>;

  /**
   * Tells the sandbox when to end itself, so its TTL holds while no server runs. Best effort:
   * the server's reaper enforces the TTL while it runs anyway.
   */
  setDeadline(handle: string, at: Date): Promise<void>;

  // Stop and remove the container. Must not fail if it is already gone.
  destroy(handle: string): Promise<void>;

  /**
   * Every container this backend created that still exists, running or not, so the reaper can
   * find orphans (containers the server no longer knows about, for example after a restart) and
   * the pool can drop containers that died while waiting.
   */
  listManaged(): Promise<Array<{ sandboxId: string; handle: string; running: boolean; exited: boolean }>>;

  // Current CPU and memory of the given containers; one that is gone is left out.
  usage(handles: string[]): Promise<Record<string, SandboxUsage>>;

  // True when sandboxes with a network from before a server restart still have their proxy policies.
  egressKept(): boolean;

  // Stop anything the backend runs for itself. Called once at shutdown; the egress proxy is left running for adopted sandboxes.
  shutdown(): Promise<void>;
}
