import Docker from "dockerode";
import { Writable } from "node:stream";
import { ConflictError, RuntimeUnavailableError } from "../errors.js";
import type { ExecResult, SandboxLimits } from "../models/sandbox.js";
import type { SandboxRuntime } from "./sandboxRuntime.js";

// Docker runtime name for gVisor. Deliberately not configurable: S1 says never fall back to runc.
const RUNTIME = "runsc";
const WORKSPACE = "/workspace";
// uid:gid of "nobody" in Debian based images. The sandbox never runs as root (S5).
const SANDBOX_UID = 65534;
const SANDBOX_USER = `${SANDBOX_UID}:${SANDBOX_UID}`;
// Every container we create carries LABEL=1 plus its sandbox id, so the reaper can match
// containers to records and remove the ones nobody knows about.
const LABEL = "agentbox";
const LABEL_ID = "agentbox.id";
// If the in-sandbox `timeout` has not ended the exec this long after its deadline,
// kill the whole container.
const GUARD_MS = 5_000;
const MB = 1024 * 1024;

export class GvisorDockerRuntime implements SandboxRuntime {
  constructor(
    private readonly docker: Docker,
    private readonly image: string,
    private readonly maxOutputBytes: number,
  ) {}

  async init(): Promise<void> {
    let info: { Runtimes?: Record<string, unknown> };
    try {
      info = await this.docker.info();
    } catch (e) {
      throw new RuntimeUnavailableError(`cannot reach Docker: ${messageOf(e)}`);
    }
    if (!info.Runtimes || !(RUNTIME in info.Runtimes)) {
      throw new RuntimeUnavailableError(
        `Docker runtime "${RUNTIME}" is not registered. Install gVisor, run "sudo runsc install", then restart Docker.`,
      );
    }
    await this.ensureImage();
  }

  private async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(this.image).inspect();
      return;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    console.log(`agentbox: pulling ${this.image} (first run only)`);
    const stream = await this.docker.pull(this.image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }

  async start(sandboxId: string, limits: SandboxLimits): Promise<string> {
    const container = await this.docker.createContainer({
      Image: this.image,
      // PID 1 only sleeps; every command runs through `docker exec`, so one sandbox can run many commands.
      Cmd: ["sleep", "infinity"],
      User: SANDBOX_USER,
      WorkingDir: WORKSPACE,
      Hostname: sandboxId,
      // HOME inside the writable area so tools like pip can write caches.
      // PYTHONUNBUFFERED so output arrives line by line (needed for streaming on Day 2).
      Env: [`HOME=${WORKSPACE}`, "PYTHONUNBUFFERED=1"],
      Labels: { [LABEL]: "1", [LABEL_ID]: sandboxId },
      HostConfig: {
        Runtime: RUNTIME, // S1: gVisor
        NetworkMode: "none", // S2: no network
        Memory: limits.memoryMb * MB, // S3: limits
        MemorySwap: limits.memoryMb * MB, // equal to Memory means no swap
        NanoCpus: Math.round(limits.cpus * 1e9),
        PidsLimit: limits.pids,
        ReadonlyRootfs: true, // S4: read-only root ...
        Tmpfs: {
          // ... plus size-limited writable tmpfs for the workspace and /tmp
          [WORKSPACE]: `rw,size=${limits.diskMb}m,uid=${SANDBOX_UID},gid=${SANDBOX_UID},mode=0755`,
          "/tmp": "rw,size=256m,mode=1777",
        },
        CapDrop: ["ALL"], // S5: no capabilities, no privilege escalation
        SecurityOpt: ["no-new-privileges"],
        // S6: no Binds, no Mounts, no Docker socket. Nothing from the host is visible inside.
      },
    });
    try {
      await container.start();
    } catch (e) {
      await container.remove({ force: true }).catch(() => {});
      throw e;
    }
    return container.id;
  }

  async exec(handle: string, cmd: string[], timeoutMs: number): Promise<ExecResult> {
    const container = this.docker.getContainer(handle);
    try {
      // coreutils `timeout` runs inside the sandbox and kills the command's whole
      // process group at the deadline. Exit code 137 means killed by SIGKILL.
      const exec = await container.exec({
        Cmd: ["timeout", "-s", "KILL", String(timeoutMs / 1000), ...cmd],
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: WORKSPACE,
      });
      const stdout = new OutputBuffer(this.maxOutputBytes);
      const stderr = new OutputBuffer(this.maxOutputBytes);
      const startedAt = Date.now();
      const stream = await exec.start({ Detach: false, Tty: false });
      this.docker.modem.demuxStream(stream, stdout, stderr);

      // Backstop for a process that keeps the output pipe open past the deadline
      // (for example a daemonised grandchild). The sandbox is lost in that case.
      const guard = setTimeout(() => {
        container.kill().catch(() => {});
        stream.destroy();
      }, timeoutMs + GUARD_MS);
      try {
        await new Promise<void>((resolve, reject) => {
          stream.on("end", resolve);
          stream.on("close", resolve);
          stream.on("error", reject);
        });
      } finally {
        clearTimeout(guard);
      }

      const durationMs = Date.now() - startedAt;
      const { ExitCode } = await exec.inspect();
      // ExitCode is null when the container died under us; report that as killed.
      const exitCode = ExitCode ?? 137;
      return {
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs,
        timedOut: exitCode === 137 && durationMs >= timeoutMs,
      };
    } catch (e) {
      throw translateDockerError(e);
    }
  }

  async destroy(handle: string): Promise<void> {
    try {
      await this.docker.getContainer(handle).remove({ force: true, v: true });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async listManaged(): Promise<Array<{ sandboxId: string; handle: string }>> {
    const containers = await this.docker.listContainers({ all: true, filters: { label: [`${LABEL}=1`] } });
    return containers.map((c) => ({ sandboxId: c.Labels[LABEL_ID] ?? "", handle: c.Id }));
  }
}

// Keeps at most `limit` bytes; the rest is dropped so one noisy command cannot
// exhaust the server's memory.
class OutputBuffer extends Writable {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.size < this.limit) {
      const keep = chunk.subarray(0, this.limit - this.size);
      this.chunks.push(keep);
      this.size += keep.length;
    }
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function statusCodeOf(e: unknown): number | undefined {
  return typeof e === "object" && e !== null && "statusCode" in e ? (e.statusCode as number) : undefined;
}

function isNotFound(e: unknown): boolean {
  return statusCodeOf(e) === 404;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 404 (container removed) and 409 (container not running) both mean the sandbox is
// gone from under the caller: a conflict with the sandbox's state, not a server bug.
function translateDockerError(e: unknown): unknown {
  const status = statusCodeOf(e);
  if (status === 404 || status === 409) return new ConflictError(`sandbox is no longer running: ${messageOf(e)}`);
  return e;
}
