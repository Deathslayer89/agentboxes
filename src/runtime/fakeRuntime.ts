import { ConflictError } from "../errors.js";
import type { ExecResult, SandboxLimits } from "../models/sandbox.js";
import type { SandboxRuntime } from "./sandboxRuntime.js";

// In-memory stand-in for tests: no Docker, no gVisor. Records what the service asked for.
export class FakeRuntime implements SandboxRuntime {
  // handle -> what was started
  readonly containers = new Map<string, { sandboxId: string; limits: SandboxLimits }>();
  readonly execCalls: Array<{ handle: string; cmd: string[]; timeoutMs: number }> = [];
  private counter = 0;

  async init(): Promise<void> {}

  async start(sandboxId: string, limits: SandboxLimits): Promise<string> {
    this.counter += 1;
    const handle = `ctr-${this.counter}`;
    this.containers.set(handle, { sandboxId, limits });
    return handle;
  }

  async exec(handle: string, cmd: string[], timeoutMs: number): Promise<ExecResult> {
    if (!this.containers.has(handle)) throw new ConflictError("container is gone");
    this.execCalls.push({ handle, cmd, timeoutMs });
    return { exitCode: 0, stdout: cmd.join(" "), stderr: "", durationMs: 1, timedOut: false };
  }

  async destroy(handle: string): Promise<void> {
    this.containers.delete(handle);
  }

  async listManaged(): Promise<Array<{ sandboxId: string; handle: string }>> {
    return [...this.containers].map(([handle, c]) => ({ sandboxId: c.sandboxId, handle }));
  }
}
