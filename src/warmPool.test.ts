import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";
import { FakeRuntime } from "./runtime/fakeRuntime.js";
import { WarmPool } from "./services/warmPool.js";

const limits = loadConfig({}).defaults;

test("fill starts `size` containers; claim hands them out and refills", async () => {
  const runtime = new FakeRuntime();
  const pool = new WarmPool(runtime, limits, 2, "img", "default");
  await pool.fill();
  assert.equal(runtime.containers.size, 2);
  assert.deepEqual(pool.stats(), { size: 2, ready: 2, starting: 0, hits: 0, misses: 0 });

  const handle = pool.claim();
  assert.equal(handle, "ctr-1");
  assert.equal(runtime.containers.get("ctr-1")?.sandboxId, "pool_default_1");
  assert.equal(runtime.containers.get("ctr-1")?.image, "img");
  await pool.fill();
  assert.equal(pool.stats().ready, 2);
  assert.equal(runtime.containers.size, 3);
  assert.equal(pool.holds("pool_default_1"), false, "a claimed slot is no longer the pool's");
  assert.equal(pool.holds("pool_default_3"), true);
});

test("a claim on an empty pool is a miss, and a size of 0 never starts anything", async () => {
  const runtime = new FakeRuntime();
  const pool = new WarmPool(runtime, limits, 0, "img", "default");
  await pool.fill();
  assert.equal(pool.claim(), undefined);
  assert.equal(runtime.containers.size, 0);
  assert.equal(pool.stats().misses, 1);
});

test("a start failure stops the fill loop without spinning; the next fill retries", async () => {
  const runtime = new FakeRuntime();
  const pool = new WarmPool(runtime, limits, 2, "img", "default");
  runtime.startError = new Error("docker is down");
  await pool.fill();
  assert.equal(pool.stats().ready, 0);
  assert.equal(pool.stats().starting, 0);
  await pool.fill();
  assert.equal(pool.stats().ready, 2);
});

test("drain destroys the ready containers and stops refilling", async () => {
  const runtime = new FakeRuntime();
  const pool = new WarmPool(runtime, limits, 2, "img", "default");
  await pool.fill();
  await pool.drain();
  assert.equal(runtime.containers.size, 0);
  await pool.fill();
  assert.equal(runtime.containers.size, 0);
  assert.equal(pool.claim(), undefined);
});
