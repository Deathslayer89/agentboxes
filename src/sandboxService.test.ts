import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { ConflictError, LimitExceededError, NotFoundError, ValidationError } from "./errors.js";
import { CounterIdGenerator } from "./id.js";
import { InMemorySandboxRepository } from "./repositories/sandboxRepository.js";
import { FakeRuntime } from "./runtime/fakeRuntime.js";
import { SandboxService } from "./services/sandboxService.js";

// Fresh service per test so tests never depend on each other.
function makeService(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig(env);
  const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
  const runtime = new FakeRuntime();
  const service = new SandboxService(new InMemorySandboxRepository(), runtime, config, clock, new CounterIdGenerator("sbx_"));
  return { service, runtime, clock, config };
}

test("create starts a container with the server defaults and a TTL", async () => {
  const { service, runtime, clock, config } = makeService();
  const sandbox = await service.create();
  assert.equal(sandbox.id, "sbx_1");
  assert.equal(sandbox.status, "ready");
  assert.deepEqual(sandbox.limits, config.defaults);
  assert.equal(sandbox.expiresAt.getTime(), clock.now().getTime() + config.defaults.ttlSeconds * 1000);
  assert.equal(runtime.containers.size, 1);
  assert.equal(service.get("sbx_1").status, "ready");
});

test("custom limits are passed to the runtime; above the maximum is rejected", async () => {
  const { service, runtime } = makeService({ MAX_MEMORY_MB: "1024" });
  const sandbox = await service.create({ memoryMb: 1024, cpus: 0.5 });
  assert.equal(sandbox.limits.memoryMb, 1024);
  assert.equal([...runtime.containers.values()][0]?.limits.cpus, 0.5);
  await assert.rejects(service.create({ memoryMb: 1025 }), ValidationError);
  await assert.rejects(service.create({ ttlSeconds: 3601 }), ValidationError);
});

test("the live sandbox cap is enforced and frees up after destroy", async () => {
  const { service } = makeService({ MAX_SANDBOXES: "1" });
  const first = await service.create();
  await assert.rejects(service.create(), LimitExceededError);
  await service.destroy(first.id);
  await service.create();
});

test("exec runs through the runtime with the default timeout", async () => {
  const { service, runtime, config } = makeService();
  const { id } = await service.create();
  const result = await service.exec(id, { cmd: ["python", "-c", "print(2+2)"] });
  assert.equal(result.stdout, "python -c print(2+2)");
  assert.deepEqual(runtime.execCalls[0]?.cmd, ["python", "-c", "print(2+2)"]);
  assert.equal(runtime.execCalls[0]?.timeoutMs, config.defaultExecTimeoutMs);
  assert.equal(service.get(id).status, "ready");
  await assert.rejects(service.exec(id, { cmd: ["true"], timeoutMs: config.maxExecTimeoutMs + 1 }), ValidationError);
});

test("destroy removes the container; exec afterwards is a conflict, get still works", async () => {
  const { service, runtime } = makeService();
  const { id } = await service.create();
  await service.destroy(id);
  assert.equal(runtime.containers.size, 0);
  assert.equal(service.get(id).status, "destroyed");
  await assert.rejects(service.exec(id, { cmd: ["true"] }), ConflictError);
  await service.destroy(id); // idempotent
  assert.throws(() => service.get("sbx_99"), NotFoundError);
});

test("the reaper expires sandboxes past their TTL and removes orphaned containers", async () => {
  const { service, runtime, clock } = makeService({ DEFAULT_TTL_SECONDS: "60" });
  const { id } = await service.create();
  await runtime.start("sbx_from_previous_run", (await service.create()).limits); // the server never recorded this one

  clock.advance(30_000);
  let pass = await service.reap();
  assert.deepEqual(pass.expired, []);
  assert.deepEqual(pass.orphans, ["sbx_from_previous_run"]);

  clock.advance(31_000);
  pass = await service.reap();
  assert.ok(pass.expired.includes(id));
  assert.equal(service.get(id).status, "expired");
  assert.equal(runtime.containers.size, 0);
});

test("long-gone records are forgotten by the reaper", async () => {
  const { service, clock } = makeService({ DEFAULT_TTL_SECONDS: "60" });
  const { id } = await service.create();
  await service.destroy(id);
  clock.advance(60_000 + 11 * 60_000);
  await service.reap();
  assert.throws(() => service.get(id), NotFoundError);
});
