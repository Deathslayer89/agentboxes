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
 * Keeps `size` default-sized containers started ahead of time so create() can hand one
 * out without waiting for Docker. Each container is used once: claimed, then destroyed
 * together with its sandbox.
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

  // Starts containers until `size` are ready or starting. Concurrent calls share one loop.
  fill(): Promise<void> {
    this.filling ??= this.fillLoop().finally(() => {
      this.filling = undefined;
    });
    return this.filling;
  }

  private async fillLoop(): Promise<void> {
    while (!this.closed && this.slots.size < this.size) {
      this.counter += 1;
      const slotId = `pool_${this.counter}`;
      this.slots.add(slotId);
      let handle: string;
      try {
        handle = await this.runtime.start(slotId, this.limits);
      } catch (e) {
        this.slots.delete(slotId);
        console.error(`warm pool: could not start a container: ${e instanceof Error ? e.message : String(e)}`);
        return; // the next claim or reaper pass tries again
      }
      if (this.closed) {
        this.slots.delete(slotId);
        await this.runtime.destroy(handle).catch(() => {});
        return;
      }
      this.ready.push({ slotId, handle });
    }
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
