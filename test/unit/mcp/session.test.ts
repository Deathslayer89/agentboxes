import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "../../../src/log.js";
import { Session, type SessionBox } from "../../../mcp/session.js";

const silentLog = { info() {}, error() {}, warn() {}, debug() {} } as unknown as Logger;

class FakeBox implements SessionBox {
  info = { startup: { source: "cold" } };
  status = "ready";
  expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  destroyed = false;
  // When set, refresh waits on this before resolving, so a test can hold one refresh open.
  refreshGate: Promise<void> | undefined;
  constructor(readonly id: string) {}
  async refresh(): Promise<{ status: string; expiresAt: string }> {
    if (this.refreshGate !== undefined) await this.refreshGate;
    return { status: this.status, expiresAt: this.expiresAt };
  }
  async extend(): Promise<unknown> {
    return {};
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

class FakeClient {
  readonly created: FakeBox[] = [];
  async create(): Promise<FakeBox> {
    const box = new FakeBox(`box${this.created.length}`);
    this.created.push(box);
    return box;
  }
}

test("a slow refresh after another call has opened a fresh sandbox reuses it instead of opening a second", async () => {
  const client = new FakeClient();
  const session = new Session<FakeBox>(client, {}, silentLog);

  const x = await session.sandbox();
  assert.equal(client.created.length, 1, "the first call opens one sandbox");

  // X is now gone, and its second refresh (the second concurrent call's) is held open.
  x.status = "expired";
  let releaseSecondRefresh: () => void = () => {};
  const held = new Promise<void>((resolve) => (releaseSecondRefresh = resolve));
  let refreshes = 0;
  x.refresh = async () => {
    refreshes += 1;
    if (refreshes === 2) await held;
    return { status: "expired", expiresAt: x.expiresAt };
  };

  const first = session.sandbox();
  const second = session.sandbox();
  const firstBox = await first; // its refresh returns at once, so it opens the replacement
  assert.equal(client.created.length, 2, "the first of the two concurrent calls opens the replacement");

  releaseSecondRefresh();
  const secondBox = await second;
  assert.equal(client.created.length, 2, "the second call must reuse the replacement, not open a third sandbox");
  assert.equal(secondBox, firstBox, "both concurrent calls return the same sandbox");
});

test("parallel calls on a fresh session share one create", async () => {
  const client = new FakeClient();
  const session = new Session<FakeBox>(client, {}, silentLog);
  const boxes = await Promise.all([session.sandbox(), session.sandbox(), session.sandbox()]);
  assert.equal(client.created.length, 1, "one create is shared across the parallel calls");
  assert.ok(boxes.every((b) => b === boxes[0]));
});

test("reset destroys the current sandbox so the next call opens a fresh one", async () => {
  const client = new FakeClient();
  const session = new Session<FakeBox>(client, {}, silentLog);
  const first = await session.sandbox();
  const reset = await session.reset();
  assert.equal(reset, first);
  assert.equal(first.destroyed, true);
  const second = await session.sandbox();
  assert.notEqual(second, first);
  assert.equal(client.created.length, 2);
});
