import type { ExecResult, SandboxLimits } from "../models/sandbox.js";

// What the service needs from an isolation backend. gVisor on Docker is the only
// implementation in v0.1; Firecracker can be added later behind the same interface.
export interface SandboxRuntime {
  // Verify the backend is usable (for example runsc is registered) and pull the base
  // image if needed. Throws RuntimeUnavailableError. Called once at startup.
  init(): Promise<void>;

  // Start an isolated container for a sandbox. Returns an opaque handle (the container id).
  start(sandboxId: string, limits: SandboxLimits): Promise<string>;

  // Run one command inside the sandbox and wait for it. Must kill it at timeoutMs.
  exec(handle: string, cmd: string[], timeoutMs: number): Promise<ExecResult>;

  // Stop and remove the container. Must not fail if it is already gone.
  destroy(handle: string): Promise<void>;

  // Every container this backend created that still exists, so the reaper can find
  // orphans (containers the server no longer knows about, for example after a restart).
  listManaged(): Promise<Array<{ sandboxId: string; handle: string }>>;
}
