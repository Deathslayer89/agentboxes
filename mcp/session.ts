import type { CreateOptions } from "../sdk/src/index.js";
import type { Logger } from "../src/log.js";

// What the session needs from a sandbox handle; the SDK's Sandbox provides all of it.
export interface SessionBox {
  readonly id: string;
  readonly info: { startup: { source: string } };
  refresh(): Promise<{ status: string; expiresAt: string }>;
  extend(): Promise<unknown>;
  destroy(): Promise<void>;
}

/**
 * One sandbox per MCP session, created on first use and replaced once it has expired or been destroyed. Parallel tool
 * calls share the single create in flight, and a call whose refresh finishes after another has already opened a fresh
 * sandbox uses that one rather than opening a second, so a session never leaks an extra sandbox.
 */
export class Session<B extends SessionBox> {
  private current: B | undefined;
  private creating: Promise<B> | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly client: { create(options: CreateOptions): Promise<B> },
    private readonly createOptions: CreateOptions,
    private readonly log: Logger,
  ) {}

  async sandbox(): Promise<B> {
    const existing = this.current;
    if (existing !== undefined) {
      const info = await existing.refresh().catch(() => undefined);
      if (info !== undefined && (info.status === "ready" || info.status === "busy")) {
        // Keep a sandbox that is still in use alive instead of losing its files at the TTL.
        if (new Date(info.expiresAt).getTime() - Date.now() < 5 * 60_000) await existing.extend().catch(() => {});
        return existing;
      }
      // Only forget it if a parallel create did not already replace it while we were refreshing.
      if (this.current === existing) this.current = undefined;
    }
    // Another call may have opened a fresh sandbox while we were refreshing; use it instead of starting a second create.
    if (this.current !== undefined && this.current !== existing) return this.current;
    this.creating ??= this.client
      .create(this.createOptions)
      .then((box) => {
        this.current = box;
        this.log.info({ sandbox: box.id, source: box.info.startup.source }, "sandbox opened for this session");
        return box;
      })
      .finally(() => {
        this.creating = undefined;
      });
    return this.creating;
  }

  // Drops the current sandbox and destroys it, so the next sandbox() opens a fresh one. Returns the one destroyed, if any.
  async reset(): Promise<B | undefined> {
    const old = this.current;
    this.current = undefined;
    if (old !== undefined) await old.destroy().catch(() => {});
    return old;
  }

  /**
   * Destroys the session's sandbox when the client goes away, waiting out a create still in flight so a disconnect
   * mid-create still cleans up. Idempotent: stdin ending, the transport closing and a signal all share one close.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      const old = this.current ?? (this.creating ? await this.creating.catch(() => undefined) : undefined);
      this.current = undefined;
      this.creating = undefined;
      if (old === undefined) return;
      this.log.info({ sandbox: old.id }, "client gone, destroying the session sandbox");
      await old.destroy().catch((err: unknown) => this.log.error({ sandbox: old.id, err }, "destroy failed"));
    })();
    return this.closing;
  }
}
