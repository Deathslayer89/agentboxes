import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import { Writable } from "node:stream";
import { ConflictError, NotFoundError, RuntimeUnavailableError, ValidationError } from "../errors.js";
import { logFor, type Logger } from "../log.js";
import type { SandboxLimits } from "../models/sandbox.js";
import { CA_DIR, type EgressAttachment, type EgressProxyManager } from "./egressProxy.js";
import type { DeniedRequest, EgressPolicy, ExecOptions, OutputListener, SandboxRuntime, SandboxUsage, RuntimeExecResult } from "./sandboxRuntime.js";

const WORKSPACE = "/workspace";
// uid:gid of "nobody" in Debian based images. The sandbox never runs as root (S5).
const SANDBOX_UID = 65534;
const SANDBOX_USER = `${SANDBOX_UID}:${SANDBOX_UID}`;
/**
 * Every container we create carries LABEL=1 plus its sandbox id, so the reaper can match
 * containers to records and remove the ones nobody knows about.
 */
const LABEL = "agentbox";
const LABEL_ID = "agentbox.id";
// "1" on containers that have their own network, so destroy() knows to remove it.
const LABEL_NETWORKED = "agentbox.networked";
/**
 * If the in-sandbox `timeout` has not ended the exec this long after its deadline,
 * kill the whole container.
 */
const GUARD_MS = 5_000;
// Where PID 1 reads the sandbox's end time, as epoch seconds. Written as root, so the sandbox user cannot move it.
const DEADLINE_FILE = "/tmp/.agentbox_deadline";
// File reads and writes are plain `cat`; this only matters if the path is a FIFO.
const FILE_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 300_000;
const MB = 1024 * 1024;

interface RunOptions {
  // Bytes to feed the command on stdin; stdin is closed right after.
  stdin?: Buffer;
  // Working directory inside the container. Defaults to /workspace.
  cwd?: string;
  // Extra environment for this command only.
  env?: Record<string, string>;
  // Kills the command when aborted.
  signal?: AbortSignal;
  // Called with each chunk as it arrives (F6 streaming).
  onOutput?: OutputListener;
  // Cap per stream on what is kept in memory. Defaults to maxOutputBytes.
  limit?: number;
  // Run as this user instead of the sandbox user; only the deadline write uses root.
  user?: string;
}

interface RunResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  // True when stdout or stderr went over the limit and was cut.
  truncated: boolean;
  // True when the container is gone: killed by the guard, or dead by the time the command ended.
  lost: boolean;
}

export class GvisorDockerRuntime implements SandboxRuntime {
  // Resolved at init: "auto" becomes runsc-kvm when registered, else runsc.
  runtimeName: string;

  constructor(
    private readonly docker: Docker,
    requestedRuntime: string,
    private readonly image: string,
    private readonly maxOutputBytes: number,
    private readonly maxFileBytes: number,
    private readonly maxArchiveBytes: number,
    private readonly egress: EgressProxyManager,
    private readonly log: Logger = logFor("runtime"),
  ) {
    this.runtimeName = requestedRuntime;
  }

  async init(): Promise<void> {
    let info: { Runtimes?: Record<string, unknown> };
    try {
      info = await this.docker.info();
    } catch (e) {
      throw new RuntimeUnavailableError(`cannot reach Docker: ${messageOf(e)}`);
    }
    const registered = info.Runtimes ?? {};
    if (this.runtimeName === "auto") this.runtimeName = "runsc-kvm" in registered ? "runsc-kvm" : "runsc";
    if (!(this.runtimeName in registered)) {
      throw new RuntimeUnavailableError(
        `Docker runtime "${this.runtimeName}" is not registered. Run "npx agentboxes setup" to install gVisor and register it.`,
      );
    }
    await this.ensureImage();
    await this.egress.init();
    if (!this.egress.available) this.log.warn({ reason: this.egress.unavailableReason }, "network allowlist is off");
  }

  private async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(this.image).inspect();
      return;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    this.log.info({ image: this.image }, "pulling the base image (first run only)");
    const stream = await this.docker.pull(this.image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }

  async start(sandboxId: string, limits: SandboxLimits, image: string, egress?: EgressPolicy): Promise<string> {
    let attachment: EgressAttachment | undefined;
    if (egress !== undefined) {
      if (!this.egress.available) throw new ValidationError(`allowHosts is not available: ${this.egress.unavailableReason}`);
      attachment = await this.egress.attach(sandboxId, egress);
    }
    try {
      return await this.createAndStart(sandboxId, limits, image, attachment);
    } catch (e) {
      if (attachment !== undefined) await this.egress.detach(sandboxId).catch(() => {});
      throw e;
    }
  }

  private async createAndStart(sandboxId: string, limits: SandboxLimits, image: string, attachment: EgressAttachment | undefined): Promise<string> {
    const container = await this.docker.createContainer({
      Image: image,
      /**
       * PID 1: a shell that reaps the orphans commands leave behind and ends the sandbox at the deadline
       * in DEADLINE_FILE, so the TTL holds while no server runs. One fork per 30 s and shell builtins
       * otherwise, because a process start under gVisor costs milliseconds of CPU. The commands
       * themselves run through `docker exec`, so one sandbox can run many.
       */
      Cmd: ["sh", "-c", `start=$(date +%s); t=0; while :; do sleep 30 & wait $!; t=$((t+30)); if [ -f ${DEADLINE_FILE} ] && read d < ${DEADLINE_FILE} && [ $((start+t)) -ge "$d" ]; then exit 0; fi; done`],
      User: SANDBOX_USER,
      WorkingDir: WORKSPACE,
      Hostname: "sandbox",
      Env: [
        `HOME=${WORKSPACE}`, // pip and similar tools write their caches under the writable workspace
        "PYTHONUNBUFFERED=1", // python output arrives line by line instead of at exit
        ...(attachment?.env ?? []),
      ],
      Labels: { [LABEL]: "1", [LABEL_ID]: sandboxId, [LABEL_NETWORKED]: attachment === undefined ? "0" : "1" },
      HostConfig: {
        Runtime: this.runtimeName, // S1: gVisor
        NetworkMode: attachment?.network ?? "none", // S2: no network, or only the sandbox's own network to the proxy
        // Under gVisor the tmpfs at /workspace lives in the sandbox's memory, so the cgroup
        // limit is processes plus files; the split between the two is not enforced.
        Memory: (limits.memoryMb + limits.diskMb) * MB,
        MemorySwap: (limits.memoryMb + limits.diskMb) * MB, // equal to Memory means no swap
        NanoCpus: Math.round(limits.cpus * 1e9),
        PidsLimit: limits.pids,
        ReadonlyRootfs: true, // S4: read-only root ...
        Tmpfs: {
          // ... plus size-limited writable tmpfs for the workspace and /tmp. Docker mounts tmpfs noexec unless told
          // otherwise, which breaks every installed script; noexec adds nothing here since an interpreter runs the file anyway.
          [WORKSPACE]: `rw,exec,size=${limits.diskMb}m,uid=${SANDBOX_UID},gid=${SANDBOX_UID},mode=0755`,
          "/tmp": "rw,exec,size=256m,mode=1777",
        },
        CapDrop: ["ALL"], // S5: no capabilities, no privilege escalation
        SecurityOpt: ["no-new-privileges"],
        // S6: no Binds, no Mounts, no Docker socket. Nothing from the host is visible inside.
      },
    });
    try {
      await container.start();
      this.log.debug({ sandbox: sandboxId, container: container.id.slice(0, 12), image, network: attachment?.network ?? "none" }, "container started");
      if (attachment?.caPem !== undefined) await this.installCa(container.id, attachment.caPem);
    } catch (e) {
      await container.remove({ force: true }).catch(() => {});
      throw e;
    }
    return container.id;
  }

  // Writes the proxy's CA into the sandbox and appends it to the image's bundle, so clients trust intercepted hosts.
  private async installCa(handle: string, caPem: string): Promise<void> {
    const script = `mkdir -p ${CA_DIR} && cat > ${CA_DIR}/ca.pem && { cat /etc/ssl/certs/ca-certificates.crt ${CA_DIR}/ca.pem > ${CA_DIR}/bundle.pem 2>/dev/null || cp ${CA_DIR}/ca.pem ${CA_DIR}/bundle.pem; }`;
    const r = await this.run(handle, ["sh", "-c", script], FILE_TIMEOUT_MS, { stdin: Buffer.from(caPem) });
    if (r.exitCode !== 0) throw new Error(`could not install the proxy CA: ${r.stderr.toString("utf8").trim()}`);
  }

  async egressLog(sandboxId: string): Promise<DeniedRequest[]> {
    return this.egress.deniedLog(sandboxId);
  }

  async setDeadline(handle: string, at: Date): Promise<void> {
    const r = await this.run(handle, ["sh", "-c", `echo ${Math.ceil(at.getTime() / 1000)} > ${DEADLINE_FILE}`], FILE_TIMEOUT_MS, { user: "0" });
    if (r.exitCode !== 0) throw new Error(`could not write the deadline: ${r.stderr.toString("utf8").trim()}`);
  }

  egressKept(): boolean {
    return this.egress.reused;
  }

  // The proxy stays up so sandboxes adopted by the next server run keep their network.
  async shutdown(): Promise<void> {}

  async exec(handle: string, cmd: string[], options: ExecOptions, onOutput?: OutputListener): Promise<RuntimeExecResult> {
    const r = await this.run(handle, cmd, options.timeoutMs, {
      cwd: options.cwd,
      env: options.env,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(onOutput === undefined ? {} : { onOutput }),
    });
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.toString("utf8"),
      stderr: r.stderr.toString("utf8"),
      durationMs: r.durationMs,
      timedOut: r.exitCode === 137 && r.durationMs >= options.timeoutMs,
      truncated: r.truncated,
      lost: r.lost,
    };
  }

  /**
   * `docker cp` cannot see /workspace: under gVisor the tmpfs lives inside the sandbox,
   * not on the host. So files travel through exec, on stdin for writes and stdout for reads.
   */
  async writeFile(handle: string, path: string, data: Buffer): Promise<void> {
    const script = 'mkdir -p "$(dirname -- "$1")" && cat > "$1"';
    const r = await this.run(handle, ["sh", "-c", script, "sh", path], FILE_TIMEOUT_MS, { stdin: data });
    if (r.exitCode !== 0) throw new ValidationError(`cannot write ${path}: ${r.stderr.toString("utf8").trim()}`);
  }

  async readFile(handle: string, path: string): Promise<Buffer> {
    const r = await this.run(handle, ["cat", "--", path], FILE_TIMEOUT_MS, { limit: this.maxFileBytes });
    if (r.exitCode !== 0) throw new NotFoundError(`cannot read ${path}: ${r.stderr.toString("utf8").trim()}`);
    if (r.truncated) throw new ValidationError(`${path} is larger than the ${this.maxFileBytes} byte limit`);
    return r.stdout;
  }

  // Whole trees travel the same way as files: a tar stream on stdin or stdout of tar inside the sandbox.
  async putArchive(handle: string, dir: string, tar: Buffer): Promise<void> {
    const r = await this.run(handle, ["sh", "-c", 'mkdir -p "$1" && tar -x -C "$1"', "sh", dir], ARCHIVE_TIMEOUT_MS, { stdin: tar });
    if (r.exitCode !== 0) throw new ValidationError(`cannot unpack into ${dir}: ${r.stderr.toString("utf8").trim()}`);
  }

  async getArchive(handle: string, dir: string): Promise<Buffer> {
    const r = await this.run(handle, ["tar", "-c", "-C", dir, "."], ARCHIVE_TIMEOUT_MS, { limit: this.maxArchiveBytes });
    if (r.exitCode !== 0) throw new NotFoundError(`cannot pack ${dir}: ${r.stderr.toString("utf8").trim()}`);
    if (r.truncated) throw new ValidationError(`${dir} packs to more than the ${this.maxArchiveBytes} byte limit`);
    return r.stdout;
  }

  // Removes the container, then its own network if it had one.
  async destroy(handle: string): Promise<void> {
    const container = this.docker.getContainer(handle);
    let labels: Record<string, string>;
    try {
      labels = ((await container.inspect()) as { Config: { Labels: Record<string, string> } }).Config.Labels;
      await container.remove({ force: true, v: true });
    } catch (e) {
      if (!isNotFound(e)) throw e;
      return;
    }
    if (labels[LABEL_NETWORKED] === "1") await this.egress.detach(labels[LABEL_ID] ?? "");
  }

  // The last CPU counters per container, so the next usage() call can turn the difference into a percentage.
  private readonly cpuSamples = new Map<string, { total: number; system: number }>();

  /**
   * One Docker stats sample per container, taken without waiting for a second one. Memory is the
   * cgroup's usage minus inactive file cache, as `docker stats` shows it; under gVisor that includes
   * the sentry. CPU percent is the container's share of the host's CPU time since the previous call.
   */
  async usage(handles: string[]): Promise<Record<string, SandboxUsage>> {
    const wanted = new Set(handles);
    for (const handle of this.cpuSamples.keys()) if (!wanted.has(handle)) this.cpuSamples.delete(handle);
    const entries = await Promise.all(
      handles.map(async (handle): Promise<[string, SandboxUsage] | undefined> => {
        let stats: Docker.ContainerStats;
        try {
          stats = await this.docker.getContainer(handle).stats({ stream: false, "one-shot": true });
        } catch {
          return undefined;
        }
        const memoryStats = (stats.memory_stats?.stats ?? {}) as Record<string, number | undefined>;
        const memory = Math.max(0, (stats.memory_stats?.usage ?? 0) - (memoryStats.inactive_file ?? memoryStats.total_inactive_file ?? 0));
        const sample = { total: stats.cpu_stats?.cpu_usage?.total_usage ?? 0, system: stats.cpu_stats?.system_cpu_usage ?? 0 };
        const previous = this.cpuSamples.get(handle);
        this.cpuSamples.set(handle, sample);
        const cpuPercent =
          previous !== undefined && sample.system > previous.system
            ? ((sample.total - previous.total) / (sample.system - previous.system)) * (stats.cpu_stats?.online_cpus || 1) * 100
            : undefined;
        return [handle, { cpuPercent, memoryMb: memory / MB }];
      }),
    );
    return Object.fromEntries(entries.filter((entry): entry is [string, SandboxUsage] => entry !== undefined));
  }

  async listManaged(): Promise<Array<{ sandboxId: string; handle: string; running: boolean; exited: boolean }>> {
    const containers = await this.docker.listContainers({ all: true, filters: { label: [`${LABEL}=1`] } });
    // A container that is neither running nor exited is still being created; only "exited" and "dead" are final.
    return containers.map((c) => ({ sandboxId: c.Labels[LABEL_ID] ?? "", handle: c.Id, running: c.State === "running", exited: c.State === "exited" || c.State === "dead" }));
  }

  /**
   * Runs one command inside the container under coreutils `timeout`, which kills the
   * command's whole process group at the deadline (exit code 137 = killed by SIGKILL).
   */
  private async run(handle: string, cmd: string[], timeoutMs: number, options: RunOptions): Promise<RunResult> {
    const container = this.docker.getContainer(handle);
    const limit = options.limit ?? this.maxOutputBytes;
    // A marker in the command's environment is how an aborted command is found and killed.
    const marker = `AGENTBOX_EXEC_ID=${randomBytes(8).toString("hex")}`;
    const onAbort = () => void this.killByMarker(container, marker).catch(() => {});
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const exec = await container.exec({
        Cmd: ["timeout", "-s", "KILL", String(timeoutMs / 1000), ...cmd],
        AttachStdin: options.stdin !== undefined,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: options.cwd ?? WORKSPACE,
        Env: [marker, ...Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`)],
        ...(options.user === undefined ? {} : { User: options.user }),
      });
      const stdout = new OutputBuffer(limit, (chunk) => options.onOutput?.("stdout", chunk));
      const stderr = new OutputBuffer(limit, (chunk) => options.onOutput?.("stderr", chunk));
      const startedAt = Date.now();
      // hijack gives us the raw socket so we can write stdin and then half-close it.
      const stream = await exec.start(
        options.stdin === undefined ? { Detach: false, Tty: false } : { Detach: false, Tty: false, hijack: true, stdin: true },
      );
      this.docker.modem.demuxStream(stream, stdout, stderr);
      if (options.stdin !== undefined) stream.end(options.stdin);

      /**
       * Backstop for a process that keeps the output pipe open past the deadline
       * (for example a daemonised grandchild). The sandbox is lost in that case.
       */
      let lost = false;
      const guard = setTimeout(() => {
        lost = true;
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
      // ExitCode is null when the container died under us; a dead container means the sandbox is lost, whatever killed it.
      if (ExitCode === null && !lost) lost = !(await this.running(container));
      return {
        exitCode: lost ? 137 : (ExitCode ?? 137),
        stdout: stdout.bytes(),
        stderr: stderr.bytes(),
        durationMs,
        truncated: stdout.truncated || stderr.truncated,
        lost,
      };
    } catch (e) {
      throw translateDockerError(e);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  // False when the container has stopped or no longer exists.
  private async running(container: Docker.Container): Promise<boolean> {
    try {
      return ((await container.inspect()) as { State: { Running: boolean } }).State.Running;
    } catch {
      return false;
    }
  }

  // Kills every process in the sandbox whose environment carries the marker.
  private async killByMarker(container: Docker.Container, marker: string): Promise<void> {
    const script = 'for p in /proc/[0-9]*; do if grep -qz -- "$1" "$p/environ" 2>/dev/null; then kill -9 "${p#/proc/}"; fi; done';
    const exec = await container.exec({ Cmd: ["sh", "-c", script, "sh", marker], AttachStdout: false, AttachStderr: false });
    // The detached start still answers with a response stream; left unread it keeps the process alive.
    const stream = await exec.start({ Detach: true });
    stream.resume();
    await new Promise<void>((resolve) => {
      stream.once("end", resolve);
      stream.once("close", resolve);
      stream.once("error", resolve);
      stream.destroy();
    });
  }
}

/**
 * Keeps at most `limit` bytes; the rest is dropped so one noisy command cannot
 * exhaust the server's memory. Every chunk still reaches the listener in full.
 */
class OutputBuffer extends Writable {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(
    private readonly limit: number,
    private readonly onChunk: (chunk: Buffer) => void,
  ) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.onChunk(chunk);
    const keep = chunk.subarray(0, Math.max(0, this.limit - this.size));
    if (keep.length < chunk.length) this.truncated = true;
    if (keep.length > 0) {
      this.chunks.push(keep);
      this.size += keep.length;
    }
    callback();
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
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

/**
 * 404 (container removed) and 409 (container not running) both mean the sandbox is
 * gone from under the caller: a conflict with the sandbox's state, not a server bug.
 */
function translateDockerError(e: unknown): unknown {
  const status = statusCodeOf(e);
  if (status === 404 || status === 409) return new ConflictError(`sandbox is no longer running: ${messageOf(e)}`);
  return e;
}
