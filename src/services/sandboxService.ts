import os from "node:os";
import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import { ConflictError, LimitExceededError, NotFoundError, ValidationError } from "../errors.js";
import type { IdGenerator } from "../id.js";
import { logFor, type Logger } from "../log.js";
import { isGone, type CreateSandboxRequest, type ExecRequest, type ExecResult, type Sandbox, type SandboxLimits, type SandboxNetwork } from "../models/sandbox.js";
import { LOCAL_OWNER } from "../models/apiKey.js";
import { DEFAULT_TEMPLATE, type Template } from "../models/template.js";
import type { SandboxRepository } from "../repositories/sandboxRepository.js";
import type { TemplateRepository } from "../repositories/templateRepository.js";
import type { DeniedRequest, EgressPolicy, OutputListener, SandboxRuntime, SecretHeader } from "../runtime/sandboxRuntime.js";

const MB = 1024 * 1024;

// What the status page shows: the host's load and memory, and every live sandbox with what it uses right now.
export interface UsageReport {
  host: { cpus: number; load1: number; memoryTotalMb: number; memoryUsedMb: number };
  sandboxes: Array<{
    id: string;
    owner: string;
    template: string;
    status: string;
    allowHosts: number;
    ageSeconds: number;
    expiresInSeconds: number;
    limits: { memoryMb: number; diskMb: number; cpus: number };
    // Null until the runtime has a sample, so the JSON shape is the same on every call.
    cpuPercent: number | null;
    memoryMb: number | null;
  }>;
}
import { Metrics } from "./metrics.js";
import type { PoolStats, WarmPools } from "./warmPool.js";
import { resolveWorkspaceDir, resolveWorkspacePath } from "./workspacePath.js";

/**
 * How long a gone sandbox stays visible in GET /sandboxes/:id after its TTL, so a
 * caller can still see "expired" or "destroyed" instead of a 404.
 */
const GONE_RETENTION_MS = 10 * 60 * 1000;

export class SandboxService {
  readonly metrics = new Metrics();

  constructor(
    private readonly sandboxes: SandboxRepository,
    private readonly templates: TemplateRepository,
    private readonly runtime: SandboxRuntime,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly pools: WarmPools,
    private readonly log: Logger = logFor("service"),
  ) {}

  async create(request: CreateSandboxRequest = {}, owner = LOCAL_OWNER): Promise<Sandbox> {
    const limits = this.applyLimits(request);
    if (this.liveCount() >= this.config.maxSandboxes) {
      throw new LimitExceededError(`server limit of ${this.config.maxSandboxes} live sandboxes reached`);
    }
    this.checkOwnerLimits(owner, limits);
    const template = request.template ?? DEFAULT_TEMPLATE;
    const egress = this.egressFor(request);
    const startedAt = performance.now();
    const now = this.clock.now();
    const sandbox: Sandbox = {
      id: this.ids.next(),
      owner,
      status: "starting",
      template,
      limits,
      network: egress?.network,
      startup: { source: "cold", ms: 0 },
      createdAt: now,
      expiresAt: new Date(now.getTime() + limits.ttlSeconds * 1000),
      handle: undefined,
      activeExecs: 0,
    };
    // Saved before the container exists so the reaper never mistakes it for an orphan.
    this.sandboxes.save(sandbox);
    try {
      // Pooled containers have no network, so a sandbox with a network always starts cold.
      const pooled = egress === undefined && this.poolable(limits) ? this.pools.claim(template) : undefined;
      if (pooled !== undefined) {
        sandbox.handle = pooled;
        sandbox.startup.source = "pool";
      } else {
        sandbox.handle = await this.runtime.start(sandbox.id, limits, await this.imageFor(template), egress?.policy);
      }
    } catch (e) {
      this.sandboxes.delete(sandbox.id);
      this.log.warn({ sandbox: sandbox.id, owner, template, err: e }, "sandbox start failed");
      throw e;
    }
    if (isGone(sandbox)) {
      // Destroyed or expired while the container was still starting.
      await this.runtime.destroy(sandbox.handle);
      sandbox.handle = undefined;
      this.sandboxes.save(sandbox);
      throw new ConflictError(`sandbox ${sandbox.id} was ${sandbox.status} while starting`);
    }
    sandbox.startup.ms = Math.round((performance.now() - startedAt) * 10) / 10;
    sandbox.status = "ready";
    this.sandboxes.save(sandbox);
    this.armDeadline(sandbox);
    this.metrics.creates[sandbox.startup.source] += 1;
    this.log.info(
      { sandbox: sandbox.id, owner, template, source: sandbox.startup.source, ms: sandbox.startup.ms, limits, allowHosts: egress?.network.allowHosts, secretHosts: egress?.network.secretHosts },
      "sandbox created",
    );
    return sandbox;
  }

  // Requests the proxy refused. A sandbox without a network has nothing to report.
  async egressLog(id: string): Promise<{ allowHosts: string[]; denied: DeniedRequest[] }> {
    const sandbox = this.get(id);
    if (sandbox.network === undefined) return { allowHosts: [], denied: [] };
    if (isGone(sandbox)) throw new ConflictError(`sandbox ${id} is ${sandbox.status}`);
    return { allowHosts: sandbox.network.allowHosts, denied: await this.runtime.egressLog(id) };
  }

  /**
   * Turns allowHosts and secrets into what the proxy enforces. Secret values come from the
   * server's environment and go only to the proxy; the record keeps host names alone.
   */
  private egressFor(request: CreateSandboxRequest): { policy: EgressPolicy; network: SandboxNetwork } | undefined {
    if (request.allowHosts === undefined && request.secrets === undefined) return undefined;
    const secrets: Record<string, SecretHeader> = {};
    for (const [host, raw] of Object.entries(request.secrets ?? {})) {
      const spec = typeof raw === "string" ? { env: raw } : raw;
      const value = this.config.secretsEnv[spec.env];
      if (value === undefined || value === "") throw new ValidationError(`secret for ${host}: ${spec.env} is not set in the server's environment`);
      const header = spec.header ?? "Authorization";
      const prefix = spec.prefix ?? (header.toLowerCase() === "authorization" ? "Bearer " : "");
      secrets[host] = { header, value: prefix + value };
    }
    // A host with a secret is allowed on 80 and 443 without listing it twice.
    const allowHosts = [...new Set([...(request.allowHosts ?? []), ...Object.keys(secrets)])];
    return { policy: { allowHosts, secrets }, network: { allowHosts, secretHosts: Object.keys(secrets) } };
  }

  // Live sandboxes of one owner (or all) with their current CPU and memory, plus the host's own numbers.
  async usage(owner?: string): Promise<UsageReport> {
    const live = this.list(false, owner).filter((s) => s.handle !== undefined);
    const byHandle = await this.runtime.usage(live.map((s) => s.handle as string));
    const now = this.clock.now().getTime();
    const tenth = (n: number | undefined) => (n === undefined ? null : Math.round(n * 10) / 10);
    return {
      host: {
        cpus: os.cpus().length,
        load1: tenth(os.loadavg()[0]) ?? 0,
        memoryTotalMb: Math.round(os.totalmem() / MB),
        memoryUsedMb: Math.round((os.totalmem() - os.freemem()) / MB),
      },
      sandboxes: live.map((s) => {
        const use = byHandle[s.handle as string];
        return {
          id: s.id,
          owner: s.owner,
          template: s.template,
          status: s.status,
          allowHosts: s.network?.allowHosts.length ?? 0,
          ageSeconds: Math.round((now - s.createdAt.getTime()) / 1000),
          expiresInSeconds: Math.max(0, Math.round((s.expiresAt.getTime() - now) / 1000)),
          limits: { memoryMb: s.limits.memoryMb, diskMb: s.limits.diskMb, cpus: s.limits.cpus },
          cpuPercent: tenth(use?.cpuPercent),
          memoryMb: tenth(use?.memoryMb),
        };
      }),
    };
  }

  stats(): { sandboxes: { live: number; max: number }; pools: Record<string, PoolStats> } {
    return { sandboxes: { live: this.liveCount(), max: this.config.maxSandboxes }, pools: this.pools.stats() };
  }

  metricsText(): string {
    return this.metrics.render(this.liveCount(), this.pools.stats());
  }

  // The default template is the base image; every other template is a labelled Docker image.
  async listTemplates(): Promise<Template[]> {
    return [{ name: DEFAULT_TEMPLATE, image: this.config.image }, ...(await this.templates.list())];
  }

  private async imageFor(template: string): Promise<string> {
    const found = (await this.listTemplates()).find((t) => t.name === template);
    if (found === undefined) throw new ValidationError(`unknown template "${template}"`);
    return found.image;
  }

  // With an owner, a sandbox that belongs to someone else is reported as not found, not as forbidden.
  get(id: string, owner?: string): Sandbox {
    const sandbox = this.sandboxes.findById(id);
    if (sandbox === undefined || (owner !== undefined && sandbox.owner !== owner)) throw new NotFoundError(`sandbox ${id} not found`);
    return sandbox;
  }

  // Live sandboxes by default; `all` includes the expired and destroyed ones still within retention.
  list(all = false, owner?: string): Sandbox[] {
    return this.sandboxes.findAll().filter((s) => (all || !isGone(s)) && (owner === undefined || s.owner === owner));
  }

  // With onOutput, chunks are delivered as they arrive; the result still holds the full output.
  async exec(id: string, request: ExecRequest, onOutput?: OutputListener, signal?: AbortSignal): Promise<ExecResult> {
    const timeoutMs = request.timeoutMs ?? this.config.defaultExecTimeoutMs;
    if (timeoutMs > this.config.maxExecTimeoutMs) {
      throw new ValidationError(`timeoutMs ${timeoutMs} exceeds the server maximum of ${this.config.maxExecTimeoutMs}`);
    }
    const options = { timeoutMs, cwd: resolveWorkspaceDir(request.cwd ?? "/workspace"), env: request.env ?? {}, ...(signal === undefined ? {} : { signal }) };
    const cmd = request.cmd.join(" ").slice(0, 300);
    this.log.debug({ sandbox: id, cmd, cwd: options.cwd, timeoutMs, env: Object.keys(options.env) }, "exec start");
    const startedAt = performance.now();
    try {
      const { lost, ...result } = await this.occupy(id, (handle) => this.runtime.exec(handle, request.cmd, options, onOutput));
      this.log.info(
        { sandbox: id, cmd, cwd: options.cwd, exitCode: result.exitCode, ms: result.durationMs, timedOut: result.timedOut, truncated: result.truncated, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) },
        "exec done",
      );
      if (lost) {
        // The command took its container down, so the record is closed now instead of saying "ready" until the TTL.
        this.log.warn({ sandbox: id, cmd }, "sandbox lost during exec; marked destroyed");
        await this.remove(this.get(id), "destroyed");
      }
      return result;
    } finally {
      this.metrics.observeExec((performance.now() - startedAt) / 1000);
    }
  }

  // Files live under /workspace only. Returns the absolute path that was written.
  async writeFile(id: string, path: unknown, data: Buffer): Promise<string> {
    const absolute = resolveWorkspacePath(path);
    if (data.length > this.config.maxFileBytes) {
      throw new ValidationError(`file is ${data.length} bytes; the limit is ${this.config.maxFileBytes}`);
    }
    await this.occupy(id, (handle) => this.runtime.writeFile(handle, absolute, data));
    this.log.info({ sandbox: id, path: absolute, bytes: data.length }, "file written");
    return absolute;
  }

  async readFile(id: string, path: unknown): Promise<Buffer> {
    const absolute = resolveWorkspacePath(path);
    const data = await this.occupy(id, (handle) => this.runtime.readFile(handle, absolute));
    this.log.info({ sandbox: id, path: absolute, bytes: data.length }, "file read");
    return data;
  }

  // Unpacks a tar archive into a directory under /workspace. Returns the absolute directory.
  async putArchive(id: string, dir: unknown, tar: Buffer): Promise<string> {
    const absolute = resolveWorkspaceDir(dir);
    if (tar.length > this.config.maxArchiveBytes) {
      throw new ValidationError(`archive is ${tar.length} bytes; the limit is ${this.config.maxArchiveBytes}`);
    }
    await this.occupy(id, (handle) => this.runtime.putArchive(handle, absolute, tar));
    this.log.info({ sandbox: id, path: absolute, bytes: tar.length }, "archive unpacked");
    return absolute;
  }

  async getArchive(id: string, dir: unknown): Promise<Buffer> {
    const absolute = resolveWorkspaceDir(dir);
    const tar = await this.occupy(id, (handle) => this.runtime.getArchive(handle, absolute));
    this.log.info({ sandbox: id, path: absolute, bytes: tar.length }, "archive packed");
    return tar;
  }

  // Runs `work` against a live sandbox, marking it busy for the duration.
  private async occupy<T>(id: string, work: (handle: string) => Promise<T>): Promise<T> {
    const sandbox = this.get(id);
    if (isGone(sandbox)) throw new ConflictError(`sandbox ${id} is ${sandbox.status}`);
    if (sandbox.handle === undefined) throw new ConflictError(`sandbox ${id} is still starting`);

    sandbox.activeExecs += 1;
    sandbox.status = "busy";
    this.sandboxes.save(sandbox);
    try {
      return await work(sandbox.handle);
    } finally {
      sandbox.activeExecs -= 1;
      // Only flip back to ready if nothing else changed the status meanwhile (destroy during exec).
      if (sandbox.activeExecs === 0 && sandbox.status === "busy") sandbox.status = "ready";
      this.sandboxes.save(sandbox);
    }
  }

  // Moves the expiry to now plus ttlSeconds (default: the sandbox's own TTL), within the server maximum.
  extend(id: string, ttlSeconds?: number): Sandbox {
    const sandbox = this.get(id);
    if (isGone(sandbox)) throw new ConflictError(`sandbox ${id} is ${sandbox.status}`);
    const ttl = ttlSeconds ?? sandbox.limits.ttlSeconds;
    if (ttl > this.config.maximums.ttlSeconds) {
      throw new ValidationError(`ttlSeconds ${ttl} exceeds the server maximum of ${this.config.maximums.ttlSeconds}`);
    }
    sandbox.expiresAt = new Date(this.clock.now().getTime() + ttl * 1000);
    this.sandboxes.save(sandbox);
    this.armDeadline(sandbox);
    this.log.info({ sandbox: id, ttlSeconds: ttl, expiresAt: sandbox.expiresAt }, "sandbox extended");
    return sandbox;
  }

  // Not awaited, so a pool create stays at a millisecond; the reaper enforces the TTL while the server runs anyway.
  private armDeadline(sandbox: Sandbox): void {
    if (sandbox.handle === undefined) return;
    this.runtime.setDeadline(sandbox.handle, sandbox.expiresAt).catch((err: unknown) => this.log.warn({ sandbox: sandbox.id, err }, "could not arm the sandbox's own deadline"));
  }

  async destroy(id: string): Promise<Sandbox> {
    const sandbox = this.get(id);
    await this.remove(sandbox, "destroyed");
    return sandbox;
  }

  /**
   * After a server restart: a record whose container still runs becomes ready again; one
   * whose container is gone is marked expired. Sandboxes with a network are destroyed
   * when the proxy did not survive, since their policies went with it.
   */
  async adopt(): Promise<{ adopted: string[]; lost: string[] }> {
    const running = new Set((await this.runtime.listManaged()).map((c) => c.handle));
    const adopted: string[] = [];
    const lost: string[] = [];
    for (const sandbox of this.sandboxes.findAll()) {
      if (isGone(sandbox)) continue;
      const alive = sandbox.handle !== undefined && running.has(sandbox.handle);
      if (alive && (sandbox.network === undefined || this.runtime.egressKept())) {
        sandbox.status = "ready";
        sandbox.activeExecs = 0;
        this.sandboxes.save(sandbox);
        adopted.push(sandbox.id);
        this.log.info({ sandbox: sandbox.id, owner: sandbox.owner, expiresAt: sandbox.expiresAt }, "sandbox adopted from the previous run");
        continue;
      }
      if (alive) await this.remove(sandbox, "destroyed");
      else {
        sandbox.status = "expired";
        sandbox.handle = undefined;
        this.sandboxes.save(sandbox);
        this.log.info({ sandbox: sandbox.id, owner: sandbox.owner }, "sandbox from the previous run is gone");
      }
      lost.push(sandbox.id);
    }
    return { adopted, lost };
  }

  /**
   * One reaper pass: destroy expired sandboxes, forget long-gone records, close sandboxes whose
   * container exited on its own, drop pool containers that died while waiting, and remove
   * containers the runtime still has that this server does not know about.
   */
  async reap(): Promise<{ expired: string[]; died: string[]; orphans: string[]; dead: string[] }> {
    const now = this.clock.now().getTime();
    const expired: string[] = [];
    for (const sandbox of this.sandboxes.findAll()) {
      if (isGone(sandbox)) {
        if (now > sandbox.expiresAt.getTime() + GONE_RETENTION_MS) this.sandboxes.delete(sandbox.id);
        continue;
      }
      if (sandbox.expiresAt.getTime() <= now) {
        await this.remove(sandbox, "expired");
        expired.push(sandbox.id);
      }
    }

    const all = await this.runtime.listManaged();
    // A live sandbox whose container exited on its own (past the memory cap, gVisor is killed as a whole) is closed here, before the TTL would.
    const died: string[] = [];
    const diedHandles = new Set<string>();
    const liveByHandle = new Map(this.sandboxes.findAll().filter((s) => !isGone(s) && s.handle !== undefined).map((s) => [s.handle, s]));
    for (const { handle, exited } of all) {
      const sandbox = liveByHandle.get(handle);
      if (sandbox === undefined || !exited) continue;
      this.log.warn({ sandbox: sandbox.id, owner: sandbox.owner, container: handle.slice(0, 12) }, "sandbox container exited on its own; marked destroyed");
      await this.remove(sandbox, "destroyed");
      died.push(sandbox.id);
      diedHandles.add(handle);
    }
    const managed = all.filter((c) => !diedHandles.has(c.handle));

    const orphans: string[] = [];
    // A dead pool container loses its slot first, so the orphan pass below removes it.
    const dead = this.pools.prune(new Set(managed.filter((c) => c.running).map((c) => c.handle)));
    for (const slot of dead) this.log.warn({ slot }, "pool container died while waiting; dropped");
    const liveHandles = new Set(this.sandboxes.findAll().filter((s) => !isGone(s)).map((s) => s.handle));
    for (const { sandboxId, handle } of managed) {
      const known = this.sandboxes.findById(sandboxId);
      if (known !== undefined && !isGone(known)) continue; // started for a sandbox that is live or still starting
      if (liveHandles.has(handle)) continue; // claimed from the pool; its label still names the pool slot
      if (this.pools.holds(sandboxId)) continue; // waiting in a pool, or starting for one
      await this.runtime.destroy(handle);
      orphans.push(sandboxId || handle);
      this.log.info({ sandbox: sandboxId || undefined, container: handle.slice(0, 12) }, "orphaned container removed");
    }
    await this.pools.fill();
    return { expired, died, orphans, dead };
  }

  // Only memory, cpus, disk and pids shape the container, so a custom TTL can still use the pool.
  private poolable(limits: SandboxLimits): boolean {
    const d = this.config.defaults;
    return limits.memoryMb === d.memoryMb && limits.cpus === d.cpus && limits.diskMb === d.diskMb && limits.pids === d.pids;
  }

  private async remove(sandbox: Sandbox, finalStatus: "expired" | "destroyed"): Promise<void> {
    if (isGone(sandbox)) return; // already removed: destroy is idempotent
    // Status first, so anything racing with us (an exec, a second destroy) sees it as gone.
    sandbox.status = finalStatus;
    this.sandboxes.save(sandbox);
    this.metrics.removals[finalStatus] += 1;
    if (sandbox.handle !== undefined) {
      await this.runtime.destroy(sandbox.handle);
      sandbox.handle = undefined;
      this.sandboxes.save(sandbox);
    }
    const lifetimeSeconds = Math.round((this.clock.now().getTime() - sandbox.createdAt.getTime()) / 1000);
    this.log.info({ sandbox: sandbox.id, owner: sandbox.owner, lifetimeSeconds }, `sandbox ${finalStatus}`);
  }

  // Fill in server defaults and refuse anything above the server maximums. Only limit fields are taken from the request.
  private applyLimits(request: CreateSandboxRequest): SandboxLimits {
    const { defaults, maximums } = this.config;
    const limits: SandboxLimits = { ...defaults };
    for (const key of Object.keys(maximums) as (keyof SandboxLimits)[]) {
      limits[key] = request[key] ?? defaults[key];
      if (limits[key] > maximums[key]) {
        throw new ValidationError(`${key} ${limits[key]} exceeds the server maximum of ${maximums[key]}`);
      }
    }
    return limits;
  }

  private liveCount(): number {
    return this.sandboxes.findAll().filter((s) => !isGone(s)).length;
  }

  // The per-key caps from AGENTBOX_API_KEYS: live sandboxes, and their memoryMb added up.
  private checkOwnerLimits(owner: string, limits: SandboxLimits): void {
    const key = this.config.apiKeys.find((k) => k.name === owner);
    if (key === undefined) return;
    const mine = this.sandboxes.findAll().filter((s) => s.owner === owner && !isGone(s));
    if (key.maxSandboxes !== undefined && mine.length >= key.maxSandboxes) {
      throw new LimitExceededError(`key "${owner}" is at its limit of ${key.maxSandboxes} live sandboxes`);
    }
    const memory = mine.reduce((sum, s) => sum + s.limits.memoryMb, 0) + limits.memoryMb;
    if (key.maxMemoryMb !== undefined && memory > key.maxMemoryMb) {
      throw new LimitExceededError(`key "${owner}" would exceed its ${key.maxMemoryMb} MB memory limit`);
    }
  }
}
