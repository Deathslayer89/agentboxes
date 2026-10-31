import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import { ConflictError, LimitExceededError, NotFoundError, ValidationError } from "../errors.js";
import type { IdGenerator } from "../id.js";
import { isGone, type CreateSandboxRequest, type ExecRequest, type ExecResult, type Sandbox, type SandboxLimits } from "../models/sandbox.js";
import type { SandboxRepository } from "../repositories/sandboxRepository.js";
import type { SandboxRuntime } from "../runtime/sandboxRuntime.js";

// How long a gone sandbox stays visible in GET /sandboxes/:id after its TTL, so a
// caller can still see "expired" or "destroyed" instead of a 404.
const GONE_RETENTION_MS = 10 * 60 * 1000;

export class SandboxService {
  constructor(
    private readonly sandboxes: SandboxRepository,
    private readonly runtime: SandboxRuntime,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async create(request: CreateSandboxRequest = {}): Promise<Sandbox> {
    const limits = this.applyLimits(request);
    if (this.liveCount() >= this.config.maxSandboxes) {
      throw new LimitExceededError(`server limit of ${this.config.maxSandboxes} live sandboxes reached`);
    }
    const now = this.clock.now();
    const sandbox: Sandbox = {
      id: this.ids.next(),
      status: "starting",
      limits,
      createdAt: now,
      expiresAt: new Date(now.getTime() + limits.ttlSeconds * 1000),
      handle: undefined,
      activeExecs: 0,
    };
    // Saved before the container exists so the reaper never mistakes it for an orphan.
    this.sandboxes.save(sandbox);
    try {
      sandbox.handle = await this.runtime.start(sandbox.id, limits);
    } catch (e) {
      this.sandboxes.delete(sandbox.id);
      throw e;
    }
    if (isGone(sandbox)) {
      // Destroyed or expired while the container was still starting.
      await this.runtime.destroy(sandbox.handle);
      sandbox.handle = undefined;
      this.sandboxes.save(sandbox);
      throw new ConflictError(`sandbox ${sandbox.id} was ${sandbox.status} while starting`);
    }
    sandbox.status = "ready";
    this.sandboxes.save(sandbox);
    return sandbox;
  }

  get(id: string): Sandbox {
    const sandbox = this.sandboxes.findById(id);
    if (sandbox === undefined) throw new NotFoundError(`sandbox ${id} not found`);
    return sandbox;
  }

  list(): Sandbox[] {
    return this.sandboxes.findAll();
  }

  async exec(id: string, request: ExecRequest): Promise<ExecResult> {
    const timeoutMs = request.timeoutMs ?? this.config.defaultExecTimeoutMs;
    if (timeoutMs > this.config.maxExecTimeoutMs) {
      throw new ValidationError(`timeoutMs ${timeoutMs} exceeds the server maximum of ${this.config.maxExecTimeoutMs}`);
    }
    const sandbox = this.get(id);
    if (isGone(sandbox)) throw new ConflictError(`sandbox ${id} is ${sandbox.status}`);
    if (sandbox.handle === undefined) throw new ConflictError(`sandbox ${id} is still starting`);

    sandbox.activeExecs += 1;
    sandbox.status = "busy";
    this.sandboxes.save(sandbox);
    try {
      return await this.runtime.exec(sandbox.handle, request.cmd, timeoutMs);
    } finally {
      sandbox.activeExecs -= 1;
      // Only flip back to ready if nothing else changed the status meanwhile (destroy during exec).
      if (sandbox.activeExecs === 0 && sandbox.status === "busy") sandbox.status = "ready";
      this.sandboxes.save(sandbox);
    }
  }

  async destroy(id: string): Promise<Sandbox> {
    const sandbox = this.get(id);
    await this.remove(sandbox, "destroyed");
    return sandbox;
  }

  // One reaper pass: destroy expired sandboxes, forget long-gone records, and remove
  // containers the runtime still has that this server does not know about.
  // main.ts calls this on a timer and once at startup.
  async reap(): Promise<{ expired: string[]; orphans: string[] }> {
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

    const orphans: string[] = [];
    for (const { sandboxId, handle } of await this.runtime.listManaged()) {
      const known = this.sandboxes.findById(sandboxId);
      if (known !== undefined && !isGone(known)) continue;
      await this.runtime.destroy(handle);
      orphans.push(sandboxId || handle);
    }
    return { expired, orphans };
  }

  private async remove(sandbox: Sandbox, finalStatus: "expired" | "destroyed"): Promise<void> {
    if (isGone(sandbox)) return; // already removed: destroy is idempotent
    // Status first, so anything racing with us (an exec, a second destroy) sees it as gone.
    sandbox.status = finalStatus;
    this.sandboxes.save(sandbox);
    if (sandbox.handle !== undefined) {
      await this.runtime.destroy(sandbox.handle);
      sandbox.handle = undefined;
      this.sandboxes.save(sandbox);
    }
  }

  // Fill in server defaults and refuse anything above the server maximums (S3b).
  private applyLimits(request: CreateSandboxRequest): SandboxLimits {
    const { defaults, maximums } = this.config;
    const limits: SandboxLimits = { ...defaults, ...request };
    for (const key of Object.keys(maximums) as (keyof SandboxLimits)[]) {
      if (limits[key] > maximums[key]) {
        throw new ValidationError(`${key} ${limits[key]} exceeds the server maximum of ${maximums[key]}`);
      }
    }
    return limits;
  }

  private liveCount(): number {
    return this.sandboxes.findAll().filter((s) => !isGone(s)).length;
  }
}
