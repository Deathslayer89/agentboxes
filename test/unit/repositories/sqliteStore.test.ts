import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Sandbox } from "../../../src/models/sandbox.js";
import { SqliteStore } from "../../../src/repositories/sqliteStore.js";

function record(id: string, status: Sandbox["status"] = "ready"): Sandbox {
  return {
    id,
    status,
    template: "default",
    limits: { memoryMb: 512, cpus: 1, diskMb: 1024, pids: 256, ttlSeconds: 600 },
    network: undefined,
    startup: { source: "pool", ms: 1 },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: new Date("2026-01-01T00:10:00Z"),
    handle: `ctr-${id}`,
    activeExecs: 2,
  };
}

test("records and settings survive closing and reopening the file; a busy record comes back ready with no execs", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-db-"));
  const path = join(dir, "nested", "agentbox.db");
  try {
    const first = new SqliteStore(path);
    first.sandboxes.save(record("sbx_1"));
    first.sandboxes.save(record("sbx_2", "busy"));
    first.sandboxes.save(record("sbx_3"));
    first.sandboxes.delete("sbx_3");
    first.settings.set("egressProxy.adminToken", "tok");
    first.close();

    const second = new SqliteStore(path);
    assert.deepEqual(second.sandboxes.findAll().map((s) => s.id).sort(), ["sbx_1", "sbx_2"]);
    const two = second.sandboxes.findById("sbx_2");
    assert.equal(two?.status, "ready");
    assert.equal(two?.activeExecs, 0);
    assert.equal(two?.expiresAt.toISOString(), "2026-01-01T00:10:00.000Z");
    assert.equal(second.settings.get("egressProxy.adminToken"), "tok");
    assert.equal(second.settings.get("missing"), undefined);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every lookup returns the same object, so in-place changes followed by save are what gets written", () => {
  const store = new SqliteStore(":memory:");
  store.sandboxes.save(record("sbx_1"));
  const a = store.sandboxes.findById("sbx_1");
  assert.equal(a, store.sandboxes.findById("sbx_1"));
  if (a === undefined) throw new Error("missing");
  a.status = "destroyed";
  store.sandboxes.save(a);
  assert.equal(store.sandboxes.findAll()[0]?.status, "destroyed");
  store.close();
});
