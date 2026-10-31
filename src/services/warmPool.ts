import type { SandboxLimits } from "../models/sandbox.js";
import type { SandboxRuntime } from "../runtime/sandboxRuntime.js";

export interface PoolStats {
  size: number;
  ready: number;
  starting: number;
  hits: number;
  misses: number;
}

/**
 * Keeps `size` default-sized containers of one image started ahead of time so create()
 * can hand one out without waiting for Docker. Each container is used once: claimed,
 * then destroyed together with its sandbox.
 */
export class WarmPool {
  private readonly ready: Array<{ slotId: string; handle: string }> = [];
  // Every slot the pool is responsible for, starting or ready. Slot ids are the containers' labels.
  private readonly slots = new Set<string>();
  private filling: Promise<void> | undefined;
  private closed = false;
  private counter = 0;
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly runtime: SandboxRuntime,
    private readonly limits: SandboxLimits,
    readonly size: number,
    private readonly image: string,
    private readonly template: string,
  ) {}

  holds(slotId: string): boolean {
    return this.slots.has(slotId);
  }

  // Hands out a ready container and starts a replacement. Undefined when the pool is empty.
  claim(): string | undefined {
    const next = this.ready.shift();
    if (next !== undefined) this.slots.delete(next.slotId);
    void this.fill();
    if (next === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return next.handle;
  }

  // Starts every missing container at once, so a burst of claims is refilled in one start's time. Concurrent calls share one fill.
  fill(): Promise<void> {
    this.filling ??= this.fillMissing().finally(() => {
      this.filling = undefined;
    });
    return this.filling;
  }

  private async fillMissing(): Promise<void> {
    while (!this.closed && this.slots.size < this.size) {
      const starts: Promise<boolean>[] = [];
      while (this.slots.size < this.size) starts.push(this.startOne());
      const results = await Promise.all(starts);
      if (results.includes(false)) return; // a failed start: the next claim or reaper pass tries again
    }
  }

  private async startOne(): Promise<boolean> {
    this.counter += 1;
    const slotId = `pool_${this.template}_${this.counter}`;
    this.slots.add(slotId);
    let handle: string;
    try {
      handle = await this.runtime.start(slotId, this.limits, this.image);
    } catch (e) {
      this.slots.delete(slotId);
      console.error(`warm pool ${this.template}: could not start a container: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    if (this.closed) {
      this.slots.delete(slotId);
      await this.runtime.destroy(handle).catch(() => {});
      return false;
    }
    this.ready.push({ slotId, handle });
    return true;
  }

  // Destroys every ready container and stops refilling. Used at shutdown.
  async drain(): Promise<void> {
    this.closed = true;
    const ready = this.ready.splice(0);
    for (const { slotId } of ready) this.slots.delete(slotId);
    await Promise.all(ready.map(({ handle }) => this.runtime.destroy(handle).catch(() => {})));
  }

  stats(): PoolStats {
    return {
      size: this.size,
      ready: this.ready.length,
      starting: this.slots.size - this.ready.length,
      hits: this.hits,
      misses: this.misses,
    };
  }
}

// One warm pool per template name.
export class WarmPools {
  private readonly pools = new Map<string, WarmPool>();

  add(template: string, pool: WarmPool): void {
    this.pools.set(template, pool);
  }

  // Undefined when there is no pool for the template or it is empty right now.
  claim(template: string): string | undefined {
    return this.pools.get(template)?.claim();
  }

  holds(slotId: string): boolean {
    for (const pool of this.pools.values()) if (pool.holds(slotId)) return true;
    return false;
  }

  async fill(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.fill()));
  }

  async drain(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.drain()));
  }

  stats(): Record<string, PoolStats> {
    return Object.fromEntries([...this.pools].map(([template, pool]) => [template, pool.stats()]));
  }
}
