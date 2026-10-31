import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "../../../src/clock.js";
import { loadConfig } from "../../../src/config.js";
import { ConflictError, LimitExceededError, NotFoundError, ValidationError } from "../../../src/errors.js";
import { CounterIdGenerator } from "../../../src/id.js";
import { InMemorySandboxRepository } from "../../../src/repositories/sandboxRepository.js";
import { InMemoryTemplateRepository } from "../../../src/repositories/templateRepository.js";
import { FakeRuntime } from "../../../src/runtime/fakeRuntime.js";
import { SandboxService } from "../../../src/services/sandboxService.js";
import { WarmPool, WarmPools } from "../../../src/services/warmPool.js";

// Fresh service per test so tests never depend on each other. Pools are off unless a test sets POOL_SIZES.
function makeService(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ POOL_SIZES: "default:0", ...env });
  const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
  const runtime = new FakeRuntime();
  const templates = new InMemoryTemplateRepository([{ name: "data-science", image: "agentbox/data-science:latest" }]);
  const pools = new WarmPools();
  for (const [template, size] of Object.entries(config.poolSizes)) {
    const image = template === "default" ? config.image : `agentbox/${template}:latest`;
    pools.add(template, new WarmPool(runtime, config.defaults, size, image, template));
  }
  const service = new SandboxService(new InMemorySandboxRepository(), templates, runtime, config, clock, new CounterIdGenerator("sbx_"), pools);
  return { service, runtime, clock, config, pools };
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
  assert.equal(runtime.execCalls[0]?.options.timeoutMs, config.defaultExecTimeoutMs);
  assert.equal(runtime.execCalls[0]?.options.cwd, "/workspace");
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
  await runtime.start("sbx_from_previous_run", (await service.create()).limits, "x"); // the server never recorded this one

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

test("files are written and read back under /workspace; bad paths and big files are refused", async () => {
  const { service, runtime } = makeService({ MAX_FILE_BYTES: "10" });
  const { id } = await service.create();
  assert.equal(await service.writeFile(id, "src/main.py", Buffer.from("print(1)")), "/workspace/src/main.py");
  assert.equal((await service.readFile(id, "/workspace/src/main.py")).toString(), "print(1)");
  assert.equal([...runtime.containers.values()][0]?.files.has("/workspace/src/main.py"), true);
  await assert.rejects(service.writeFile(id, "../escape.py", Buffer.from("x")), ValidationError);
  await assert.rejects(service.writeFile(id, "big.bin", Buffer.alloc(11)), ValidationError);
  await assert.rejects(service.readFile(id, "missing.py"), NotFoundError);
  assert.equal(service.get(id).status, "ready");
});

test("create takes a container from the pool when the shape matches the defaults, otherwise starts cold", async () => {
  const { service, runtime, pools } = makeService({ POOL_SIZES: "default:1" });
  await pools.fill();
  const pooled = await service.create({ ttlSeconds: 60 }); // a custom TTL does not change the container
  assert.equal(pooled.startup.source, "pool");
  assert.equal(pooled.handle, "ctr-1");
  const cold = await service.create({ memoryMb: 256 });
  assert.equal(cold.startup.source, "cold");
  assert.equal(runtime.containers.get(cold.handle ?? "")?.limits.memoryMb, 256);
  await pools.fill();
  assert.deepEqual(service.stats(), { sandboxes: { live: 2, max: 20 }, pools: { default: { size: 1, ready: 1, starting: 0, hits: 1, misses: 0 } } });
});

test("the reaper leaves pool containers and claimed pool containers alone", async () => {
  const { service, runtime, pools } = makeService({ POOL_SIZES: "default:1" });
  await pools.fill();
  const claimed = await service.create();
  await runtime.start("sbx_orphan", claimed.limits, "x");
  const { orphans } = await service.reap();
  assert.deepEqual(orphans, ["sbx_orphan"]);
  assert.equal(service.get(claimed.id).status, "ready");
  assert.equal(pools.stats().default?.ready, 1);
  assert.equal(runtime.containers.size, 2);
});

test("a template picks its image and its own pool; an unknown template is refused", async () => {
  const { service, runtime, pools } = makeService({ POOL_SIZES: "default:0,data-science:1" });
  await pools.fill();
  const cold = await service.create();
  assert.equal(runtime.containers.get(cold.handle ?? "")?.image, "python:3.12-slim");
  const pooled = await service.create({ template: "data-science" });
  assert.equal(pooled.template, "data-science");
  assert.equal(pooled.startup.source, "pool");
  assert.equal(runtime.containers.get(pooled.handle ?? "")?.image, "agentbox/data-science:latest");
  const coldTemplate = await service.create({ template: "data-science", memoryMb: 256 });
  assert.equal(coldTemplate.startup.source, "cold");
  assert.equal(runtime.containers.get(coldTemplate.handle ?? "")?.image, "agentbox/data-science:latest");
  await assert.rejects(service.create({ template: "nope" }), ValidationError);
  assert.deepEqual(await service.listTemplates(), [
    { name: "default", image: "python:3.12-slim" },
    { name: "data-science", image: "agentbox/data-science:latest" },
  ]);
});

test("allowHosts and secrets become an egress policy; the value comes from the server env and never touches the record", async () => {
  const { service, runtime, pools } = makeService({ POOL_SIZES: "default:1", OPENAI_API_KEY: "sk-test" });
  await pools.fill();
  const box = await service.create({ allowHosts: ["pypi.org"], secrets: { "api.openai.com": "OPENAI_API_KEY" } });
  assert.equal(box.startup.source, "cold", "a sandbox with a network never comes from the pool");
  assert.deepEqual(box.network, { allowHosts: ["pypi.org", "api.openai.com"], secretHosts: ["api.openai.com"] });
  assert.deepEqual(runtime.containers.get(box.handle ?? "")?.egress, { allowHosts: ["pypi.org", "api.openai.com"], secrets: { "api.openai.com": "Bearer sk-test" } });
  assert.equal(JSON.stringify(box).includes("sk-test"), false);
  await assert.rejects(service.create({ secrets: { "api.openai.com": "MISSING_KEY" } }), /MISSING_KEY is not set/);
  const plain = await service.create();
  assert.equal(plain.network, undefined);
  assert.equal(runtime.containers.get(plain.handle ?? "")?.egress, undefined);
  assert.deepEqual(await service.egressLog(plain.id), { allowHosts: [], denied: [] });
  runtime.deniedLogs.set(box.id, [{ at: "now", method: "CONNECT", host: "example.com", port: 443, reason: "host not in allowHosts" }]);
  assert.equal((await service.egressLog(box.id)).denied.length, 1);
  await service.destroy(box.id);
  await assert.rejects(service.egressLog(box.id), ConflictError);
});

test("exec passes a validated cwd and per-command env to the runtime", async () => {
  const { service, runtime } = makeService();
  const { id } = await service.create();
  await service.exec(id, { cmd: ["npm", "test"], cwd: "app/", env: { CI: "1" } });
  assert.deepEqual(runtime.execCalls[0]?.options, { timeoutMs: 30_000, cwd: "/workspace/app", env: { CI: "1" } });
  await service.exec(id, { cmd: ["ls"], cwd: "/workspace" });
  assert.equal(runtime.execCalls[1]?.options.cwd, "/workspace");
  await assert.rejects(service.exec(id, { cmd: ["ls"], cwd: "../" }), ValidationError);
});
