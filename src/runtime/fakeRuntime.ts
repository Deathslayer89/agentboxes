import { ConflictError, NotFoundError } from "../errors.js";
import type { ExecResult, SandboxLimits } from "../models/sandbox.js";
import type { DeniedRequest, EgressPolicy, ExecOptions, OutputListener, SandboxRuntime, SandboxUsage } from "./sandboxRuntime.js";

// In-memory stand-in for tests: no Docker, no gVisor. Records what the service asked for.
export class FakeRuntime implements SandboxRuntime {
  // handle -> what was started
  readonly containers = new Map<string, { sandboxId: string; limits: SandboxLimits; image: string; egress: EgressPolicy | undefined; files: Map<string, Buffer> }>();
  // sandboxId -> denied requests the fake "proxy" reports
  readonly deniedLogs = new Map<string, DeniedRequest[]>();
  readonly execCalls: Array<{ handle: string; cmd: string[]; options: ExecOptions }> = [];
  // When set, the next start() throws this instead of starting a container.
  startError: Error | undefined;
  // When set, every start() waits on it, so a test can see starts in flight.
  startGate: Promise<void> | undefined;
  // When set, merged into the next exec() result, for example { timedOut: true, exitCode: 137 }.
  nextExecResult: Partial<ExecResult> | undefined;
  // Handles whose container has exited; listManaged() reports them as not running.
  readonly dead = new Set<string>();
  private counter = 0;

  async init(): Promise<void> {}

  async start(sandboxId: string, limits: SandboxLimits, image: string, egress?: EgressPolicy): Promise<string> {
    if (this.startError !== undefined) {
      const error = this.startError;
      this.startError = undefined;
      throw error;
    }
    if (this.startGate !== undefined) await this.startGate;
    this.counter += 1;
    const handle = `ctr-${this.counter}`;
    this.containers.set(handle, { sandboxId, limits, image, egress, files: new Map() });
    return handle;
  }

  async egressLog(sandboxId: string): Promise<DeniedRequest[]> {
    return this.deniedLogs.get(sandboxId) ?? [];
  }

  // Fixed numbers for every known container, so tests can check the report's shape.
  async usage(handles: string[]): Promise<Record<string, SandboxUsage>> {
    return Object.fromEntries(handles.filter((h) => this.containers.has(h)).map((h) => [h, { cpuPercent: 12.5, memoryMb: 64 }]));
  }

  // What egressKept() answers; tests flip it to simulate a lost proxy.
  egressKeptAcrossRestart = true;

  egressKept(): boolean {
    return this.egressKeptAcrossRestart;
  }

  async shutdown(): Promise<void> {}

  // Echoes the command back on stdout, in two chunks so streaming tests see more than one.
  async exec(handle: string, cmd: string[], options: ExecOptions, onOutput?: OutputListener): Promise<ExecResult> {
    this.container(handle);
    this.execCalls.push({ handle, cmd, options });
    const text = cmd.join(" ");
    onOutput?.("stdout", Buffer.from(text.slice(0, 3)));
    onOutput?.("stdout", Buffer.from(text.slice(3)));
    onOutput?.("stderr", Buffer.from(""));
    const override = this.nextExecResult ?? {};
    this.nextExecResult = undefined;
    return { exitCode: 0, stdout: text, stderr: "", durationMs: 1, timedOut: false, truncated: false, ...override };
  }

  async writeFile(handle: string, path: string, data: Buffer): Promise<void> {
    this.container(handle).files.set(path, data);
  }

  async readFile(handle: string, path: string): Promise<Buffer> {
    const data = this.container(handle).files.get(path);
    if (data === undefined) throw new NotFoundError(`cannot read ${path}`);
    return data;
  }

  // Archives are kept as-is under the directory key; nothing is unpacked.
  async putArchive(handle: string, dir: string, tar: Buffer): Promise<void> {
    this.container(handle).files.set(`${dir}.tar`, tar);
  }

  async getArchive(handle: string, dir: string): Promise<Buffer> {
    const tar = this.container(handle).files.get(`${dir}.tar`);
    if (tar === undefined) throw new NotFoundError(`cannot pack ${dir}`);
    return tar;
  }

  async destroy(handle: string): Promise<void> {
    this.containers.delete(handle);
  }

  async listManaged(): Promise<Array<{ sandboxId: string; handle: string; running: boolean }>> {
    return [...this.containers].map(([handle, c]) => ({ sandboxId: c.sandboxId, handle, running: !this.dead.has(handle) }));
  }

  private container(handle: string) {
    const c = this.containers.get(handle);
    if (c === undefined) throw new ConflictError("container is gone");
    return c;
  }
}
