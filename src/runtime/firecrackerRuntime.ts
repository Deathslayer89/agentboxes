import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, type WriteStream } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { ConflictError, NotFoundError, RuntimeUnavailableError, ValidationError } from "../errors.js";
import type { ExecResult, SandboxLimits } from "../models/sandbox.js";
import type { DeniedRequest, EgressPolicy, ExecOptions, OutputListener, SandboxRuntime, SandboxUsage, RuntimeExecResult } from "./sandboxRuntime.js";

const MB = 1024 * 1024;
// How long to wait for a VM to boot to READY, or for a restored one to answer the seed.
const BOOT_TIMEOUT_MS = 30_000;
// Lines that are not part of the agent's protocol (kernel messages) are ignored.
const KERNEL_ARGS = "console=ttyS0 reboot=k panic=1 pci=off quiet loglevel=0 init=/agentbox-init ro";

interface Vm {
  id: string;
  process: ChildProcess;
  socket: string;
  // The guest's console input: a FIFO, because a restored serial device does not read from a socketpair.
  input: WriteStream;
  inputPath: string;
  // One command at a time: the guest agent is a single shell loop.
  queue: Promise<unknown>;
  // Resolvers waiting for the next RESULT/SEEDED/PONG line.
  waiting: Array<{ prefix: string; resolve: (line: string) => void; reject: (err: Error) => void }>;
  ready: boolean;
}

/**
 * Sandboxes as Firecracker microVMs on a KVM host: a real guest kernel per sandbox, with a
 * read-only root filesystem image and a tmpfs workspace. Default-sized sandboxes restore
 * from one snapshot taken at the agent's READY state; other sizes boot cold. Commands and
 * files travel over the serial console; there is no network and no template support yet.
 */
export class FirecrackerRuntime implements SandboxRuntime {
  readonly runtimeName = "firecracker";
  private readonly vms = new Map<string, Vm>();
  private readonly dir: string;
  private readonly binary: string;
  private readonly kernel: string;
  private readonly rootfs: string;
  private readonly snapshotDir: string;
  // API sockets live in a short path: a Unix socket path must stay under 108 bytes.
  private readonly socketDir = `${tmpdir()}/agentbox-fc-${process.getuid?.() ?? 0}`;

  constructor(
    dataDir: string,
    // The shape every snapshot-restored sandbox has; other limits boot cold.
    private readonly snapshotLimits: SandboxLimits,
    private readonly maxOutputBytes: number,
  ) {
    this.dir = `${dataDir}/firecracker`;
    this.binary = `${this.dir}/bin/firecracker`;
    this.kernel = `${this.dir}/vmlinux`;
    this.rootfs = `${this.dir}/rootfs.ext4`;
    this.snapshotDir = `${this.dir}/snapshot`;
  }

  async init(): Promise<void> {
    for (const [what, path] of [["firecracker binary", this.binary], ["guest kernel", this.kernel], ["root filesystem", this.rootfs]] as const) {
      if (!existsSync(path)) throw new RuntimeUnavailableError(`${what} is missing at ${path}; run firecracker/setup.sh first`);
    }
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    } catch {
      throw new RuntimeUnavailableError("/dev/kvm is not accessible; the Firecracker runtime needs KVM");
    }
    mkdirSync(`${this.dir}/vms`, { recursive: true });
    mkdirSync(this.socketDir, { recursive: true });
    this.killLeftovers();
    if (!existsSync(`${this.snapshotDir}/vmstate`)) await this.takeSnapshot();
  }

  async start(sandboxId: string, limits: SandboxLimits, _image: string, egress?: EgressPolicy): Promise<string> {
    if (egress !== undefined) throw new ValidationError("the firecracker runtime has no network support yet");
    const sameShape = limits.memoryMb === this.snapshotLimits.memoryMb && limits.cpus === this.snapshotLimits.cpus && limits.diskMb === this.snapshotLimits.diskMb;
    const vm = sameShape ? await this.restore(sandboxId) : await this.boot(sandboxId, limits);
    this.vms.set(vm.id, vm);
    return vm.id;
  }

  async exec(handle: string, cmd: string[], options: ExecOptions, onOutput?: OutputListener): Promise<RuntimeExecResult> {
    const vm = this.vm(handle);
    const script = [`cd ${quote(options.cwd)} || exit 127`, ...Object.entries(options.env).map(([k, v]) => `export ${k}=${quote(v)}`), `exec ${cmd.map(quote).join(" ")}`].join("\n");
    const startedAt = Date.now();
    const line = await this.send(vm, `EXEC ${randomBytes(4).toString("hex")} ${Math.ceil(options.timeoutMs / 1000)} ${Buffer.from(script).toString("base64")}`, "RESULT ", options.timeoutMs + 5_000);
    const [, , code, out, err] = line.split(" ");
    const stdout = decode(out);
    const stderr = decode(err);
    const durationMs = Date.now() - startedAt;
    const exitCode = Number(code);
    if (onOutput !== undefined) {
      if (stdout.length > 0) onOutput("stdout", stdout);
      if (stderr.length > 0) onOutput("stderr", stderr);
    }
    return {
      exitCode,
      stdout: stdout.subarray(0, this.maxOutputBytes).toString("utf8"),
      stderr: stderr.subarray(0, this.maxOutputBytes).toString("utf8"),
      durationMs,
      timedOut: exitCode === 137 && durationMs >= options.timeoutMs,
      truncated: stdout.length > this.maxOutputBytes || stderr.length > this.maxOutputBytes,
      // A VM that died answers nothing and send() throws, so a result here always has a live VM behind it.
      lost: false,
    };
  }

  async writeFile(handle: string, path: string, data: Buffer): Promise<void> {
    const r = await this.run(handle, `mkdir -p "$(dirname -- ${quote(path)})" && printf %s ${quote(data.toString("base64"))} | base64 -d > ${quote(path)}`);
    if (r.exitCode !== 0) throw new ValidationError(`cannot write ${path}: ${r.stderr.trim()}`);
  }

  async readFile(handle: string, path: string): Promise<Buffer> {
    const r = await this.run(handle, `base64 -w0 -- ${quote(path)}`);
    if (r.exitCode !== 0) throw new NotFoundError(`cannot read ${path}: ${r.stderr.trim()}`);
    return Buffer.from(r.stdout, "base64");
  }

  async putArchive(handle: string, dir: string, tar: Buffer): Promise<void> {
    const r = await this.run(handle, `mkdir -p ${quote(dir)} && printf %s ${quote(tar.toString("base64"))} | base64 -d | tar -x -C ${quote(dir)}`);
    if (r.exitCode !== 0) throw new ValidationError(`cannot unpack into ${dir}: ${r.stderr.trim()}`);
  }

  async getArchive(handle: string, dir: string): Promise<Buffer> {
    const r = await this.run(handle, `tar -c -C ${quote(dir)} . | base64 -w0`);
    if (r.exitCode !== 0) throw new NotFoundError(`cannot pack ${dir}: ${r.stderr.trim()}`);
    return Buffer.from(r.stdout, "base64");
  }

  async destroy(handle: string): Promise<void> {
    const vm = this.vms.get(handle);
    if (vm === undefined) return;
    this.vms.delete(handle);
    vm.process.kill("SIGKILL");
    vm.input.destroy();
    rmSync(vm.socket, { force: true });
    rmSync(vm.inputPath, { force: true });
    rmSync(`${this.dir}/vms/${vm.id}.pid`, { force: true });
  }

  // Only VMs started by this process can be driven; a previous run's VMs were killed at init.
  async listManaged(): Promise<Array<{ sandboxId: string; handle: string; running: boolean; exited: boolean }>> {
    return [...this.vms].map(([id, vm]) => ({ sandboxId: id, handle: id, running: vm.process.exitCode === null, exited: vm.process.exitCode !== null }));
  }

  // The last CPU tick count per VM process, so the next usage() call can turn the difference into a percentage.
  private readonly cpuSamples = new Map<string, { ticks: number; at: number }>();

  // Resident memory and CPU time of each Firecracker process, read from /proc; Linux counts CPU time in 1/100 s ticks.
  async usage(handles: string[]): Promise<Record<string, SandboxUsage>> {
    const result: Record<string, SandboxUsage> = {};
    for (const handle of handles) {
      const pid = this.vms.get(handle)?.process.pid;
      if (pid === undefined) continue;
      let status: string;
      let stat: string;
      try {
        status = readFileSync(`/proc/${pid}/status`, "utf8");
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        continue;
      }
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
      // After the command name in parentheses, utime and stime are the 12th and 13th fields.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[11]) + Number(fields[12]);
      const at = performance.now();
      const previous = this.cpuSamples.get(handle);
      this.cpuSamples.set(handle, { ticks, at });
      const cpuPercent = previous === undefined ? undefined : ((ticks - previous.ticks) / 100 / ((at - previous.at) / 1000)) * 100;
      result[handle] = { cpuPercent, memoryMb: rssKb / 1024 };
    }
    for (const handle of this.cpuSamples.keys()) if (!handles.includes(handle)) this.cpuSamples.delete(handle);
    return result;
  }

  async egressLog(): Promise<DeniedRequest[]> {
    return [];
  }

  egressKept(): boolean {
    return false;
  }

  // Every VM dies with the server, including one that was still restoring for the pool.
  async shutdown(): Promise<void> {
    for (const id of [...this.vms.keys()]) await this.destroy(id);
    this.killLeftovers();
  }

  // The serial channel dies with this process, so VMs from an earlier run can only be killed.
  private killLeftovers(): void {
    for (const file of readdirSync(`${this.dir}/vms`)) {
      if (!file.endsWith(".pid")) continue;
      const pid = Number(readFileSync(`${this.dir}/vms/${file}`, "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      rmSync(`${this.dir}/vms/${file}`, { force: true });
      rmSync(`${this.socketDir}/${file.replace(/\.pid$/, ".sock")}`, { force: true });
      rmSync(`${this.socketDir}/${file.replace(/\.pid$/, ".in")}`, { force: true });
    }
  }

  private async run(handle: string, script: string): Promise<ExecResult> {
    return this.exec(handle, ["sh", "-c", script], { timeoutMs: 300_000, cwd: "/workspace", env: {} });
  }

  private vm(handle: string): Vm {
    const vm = this.vms.get(handle);
    if (vm === undefined || vm.process.exitCode !== null) throw new ConflictError("sandbox is no longer running");
    return vm;
  }

  // Launches a Firecracker process with its API socket and wires the serial console lines to waiters.
  private launch(id: string): Vm {
    const socket = `${this.socketDir}/${id}.sock`;
    const inputPath = `${this.socketDir}/${id}.in`;
    rmSync(socket, { force: true });
    rmSync(inputPath, { force: true });
    execFileSync("mkfifo", [inputPath]);
    // Opened read-write so the open never blocks and the guest never sees end of input.
    const inputFd = openSync(inputPath, "r+");
    const child = spawn(this.binary, ["--api-sock", socket], { stdio: [inputFd, "pipe", "pipe"] });
    writeFileSync(`${this.dir}/vms/${id}.pid`, String(child.pid));
    // The stream owns the descriptor and closes it on destroy; the child holds its own copy.
    const input = createWriteStream("", { fd: inputFd, autoClose: true });
    const vm: Vm = { id, process: child, socket, input, inputPath, queue: Promise.resolve(), waiting: [], ready: false };
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (line === "AGENTBOX-READY") vm.ready = true;
      const index = vm.waiting.findIndex((w) => line.startsWith(w.prefix));
      if (index >= 0) vm.waiting.splice(index, 1)[0]?.resolve(line);
    });
    child.stderr?.resume();
    child.on("exit", () => {
      for (const w of vm.waiting.splice(0)) w.reject(new ConflictError("sandbox is no longer running"));
    });
    return vm;
  }

  private async api(vm: Vm, method: string, path: string, body?: unknown): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ socketPath: vm.socket, method, path, headers: { "content-type": "application/json" } }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => ((res.statusCode ?? 500) < 300 ? resolve() : reject(new Error(`firecracker ${method} ${path}: ${res.statusCode} ${text}`))));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  // Waits until the API socket answers, which takes a few milliseconds after spawn.
  private async waitForApi(vm: Vm): Promise<void> {
    for (let i = 0; i < 200; i++) {
      try {
        await this.api(vm, "GET", "/");
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error("firecracker API socket did not come up");
  }

  private async boot(id: string, limits: SandboxLimits): Promise<Vm> {
    const vm = this.launch(id);
    try {
      await this.waitForApi(vm);
      await this.api(vm, "PUT", "/machine-config", { vcpu_count: Math.max(1, Math.ceil(limits.cpus)), mem_size_mib: limits.memoryMb + limits.diskMb });
      await this.api(vm, "PUT", "/boot-source", { kernel_image_path: this.kernel, boot_args: `${KERNEL_ARGS} AGENTBOX_DISK_MB=${limits.diskMb}` });
      await this.api(vm, "PUT", "/drives/rootfs", { drive_id: "rootfs", path_on_host: this.rootfs, is_root_device: true, is_read_only: true });
      const ready = this.expect(vm, "AGENTBOX-READY", BOOT_TIMEOUT_MS);
      await this.api(vm, "PUT", "/actions", { action_type: "InstanceStart" });
      await ready;
      return vm;
    } catch (e) {
      await this.destroy(id).catch(() => {});
      vm.process.kill("SIGKILL");
      throw e;
    }
  }

  // Boots one default-sized VM to READY, pauses it and writes its memory and state to disk.
  private async takeSnapshot(): Promise<void> {
    mkdirSync(this.snapshotDir, { recursive: true });
    const vm = await this.boot("snapshot-source", this.snapshotLimits);
    try {
      await this.api(vm, "PATCH", "/vm", { state: "Paused" });
      await this.api(vm, "PUT", "/snapshot/create", { snapshot_type: "Full", snapshot_path: `${this.snapshotDir}/vmstate`, mem_file_path: `${this.snapshotDir}/mem` });
    } finally {
      this.vms.set(vm.id, vm);
      await this.destroy(vm.id);
    }
  }

  // A restored VM is a clone of the snapshot, so fresh entropy goes in before it runs anything.
  private async restore(id: string): Promise<Vm> {
    const vm = this.launch(id);
    try {
      await this.waitForApi(vm);
      await this.api(vm, "PUT", "/snapshot/load", {
        snapshot_path: `${this.snapshotDir}/vmstate`,
        mem_backend: { backend_type: "File", backend_path: `${this.snapshotDir}/mem` },
        resume_vm: true,
      });
      vm.ready = true;
      // Input written in the first milliseconds after resume can go unnoticed, so probe until the guest answers.
      let answered = false;
      for (let attempt = 0; attempt < 20 && !answered; attempt++) {
        answered = await this.send(vm, "PING", "PONG", 250).then(() => true, () => false);
      }
      if (!answered) throw new Error("the restored guest did not answer");
      await this.send(vm, `SEED ${randomBytes(64).toString("base64")}`, "SEEDED", BOOT_TIMEOUT_MS);
      return vm;
    } catch (e) {
      await this.destroy(id).catch(() => {});
      vm.process.kill("SIGKILL");
      throw e;
    }
  }

  private expect(vm: Vm, prefix: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        vm.waiting.splice(vm.waiting.indexOf(waiter), 1);
        reject(new Error(`no "${prefix}" from the guest within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter = {
        prefix,
        resolve: (line: string) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      vm.waiting.push(waiter);
    });
  }

  // Writes one protocol line and returns the guest's reply, one request at a time per VM.
  private send(vm: Vm, line: string, replyPrefix: string, timeoutMs: number): Promise<string> {
    const turn = vm.queue.then(async () => {
      const reply = this.expect(vm, replyPrefix, timeoutMs);
      vm.input.write(line + "\n");
      return reply;
    });
    vm.queue = turn.catch(() => {});
    return turn;
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function decode(field: string | undefined): Buffer {
  return field === undefined || field === "-" ? Buffer.alloc(0) : Buffer.from(field, "base64");
}
