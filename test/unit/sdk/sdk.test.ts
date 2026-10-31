import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Agentbox, AgentboxError, ExecTimeout, PoolExhausted, SandboxNotFound, type ExecEvent } from "../../../sdk/src/index.js";
import { FakeClock } from "../../../src/clock.js";
import { loadConfig } from "../../../src/config.js";
import { createApp } from "../../../src/http/app.js";
import { CounterIdGenerator } from "../../../src/id.js";
import { InMemorySandboxRepository } from "../../../src/repositories/sandboxRepository.js";
import { InMemoryTemplateRepository } from "../../../src/repositories/templateRepository.js";
import { FakeRuntime } from "../../../src/runtime/fakeRuntime.js";
import { SandboxService } from "../../../src/services/sandboxService.js";
import { WarmPools } from "../../../src/services/warmPool.js";

// The real HTTP stack on a random port with the fake runtime, so the SDK is tested over real sockets without Docker.
const runtime = new FakeRuntime();
const config = loadConfig({ POOL_SIZES: "default:0", MAX_SANDBOXES: "2" });
const service = new SandboxService(
  new InMemorySandboxRepository(),
  new InMemoryTemplateRepository([{ name: "data-science", image: "agentbox/data-science:latest" }]),
  runtime,
  config,
  new FakeClock(new Date("2026-01-01T00:00:00Z")),
  new CounterIdGenerator("sbx_"),
  new WarmPools(),
);
let server: ServerType;
let agentbox: Agentbox;

before(async () => {
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: createApp(service, { apiKeys: [{ name: "default", key: "k1" }] }).fetch, hostname: "127.0.0.1", port: 0 }, (info) => resolve(info.port));
  });
  agentbox = new Agentbox({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k1" });
});

after(() => {
  server.close();
});

test("create, exec, files, stream, destroy", async () => {
  const box = await agentbox.create({ template: "data-science", ttlSeconds: 60 });
  assert.equal(box.id, "sbx_1");
  assert.equal(box.info.template, "data-science");
  assert.equal(box.info.limits.ttlSeconds, 60);

  const r = await box.exec(["python", "-c", "print(2+2)"], { timeoutMs: 1000 });
  assert.equal(r.stdout, "python -c print(2+2)");
  assert.equal(runtime.execCalls.at(-1)?.options.timeoutMs, 1000);
  await box.exec(["pytest"], { cwd: "tests", env: { PYTHONPATH: "/workspace" } });
  // Over HTTP the request's abort signal rides along; only the caller's options are compared.
  const { timeoutMs, cwd, env } = runtime.execCalls.at(-1)?.options ?? {};
  assert.deepEqual({ timeoutMs, cwd, env }, { timeoutMs: 30_000, cwd: "/workspace/tests", env: { PYTHONPATH: "/workspace" } });

  await box.writeFile("src/main.py", "print('hi')");
  assert.equal(await box.readFile("src/main.py"), "print('hi')");
  await box.writeFile("bin", new Uint8Array([0, 255]));
  assert.deepEqual(await box.readFileBytes("/workspace/bin"), new Uint8Array([0, 255]));

  // The fake runtime sends "ech", "o hi" and an empty stderr chunk; the SDK joins them into lines.
  await box.uploadTar(new Uint8Array([1, 2, 3]), "incoming");
  assert.deepEqual(await box.downloadTar("incoming"), new Uint8Array([1, 2, 3]));

  const events: ExecEvent[] = [];
  for await (const event of box.execStream(["echo", "hi"])) events.push(event);
  assert.deepEqual(events, [
    { type: "stdout", text: "echo hi" },
    { type: "exit", exitCode: 0, durationMs: 1, timedOut: false, truncated: false },
  ]);
  const lines: ExecEvent[] = [];
  for await (const event of box.execStream(["a\nb\n", "c"])) lines.push(event);
  assert.deepEqual(lines, [
    { type: "stdout", text: "a\n" },
    { type: "stdout", text: "b\n" },
    { type: "stdout", text: " c" },
    { type: "exit", exitCode: 0, durationMs: 1, timedOut: false, truncated: false },
  ]);

  const before = box.info.expiresAt;
  await box.extend(1800);
  assert.ok(new Date(box.info.expiresAt) > new Date(before));

  assert.equal((await agentbox.list()).length, 1);
  assert.equal((await agentbox.get(box.id)).info.status, "ready");
  await box.destroy();
  assert.equal(box.info.status, "destroyed");
  assert.equal((await box.refresh()).status, "destroyed");
  assert.deepEqual(await agentbox.templates(), [
    { name: "default", image: "python:3.12-slim" },
    { name: "data-science", image: "agentbox/data-science:latest" },
  ]);
  assert.equal((await agentbox.stats()).sandboxes.live, 0);
  assert.equal((await agentbox.list()).length, 0);
});

test("typed errors: not found, pool exhausted, exec timeout, wrong key, validation", async () => {
  await assert.rejects(agentbox.get("sbx_nope"), SandboxNotFound);

  const a = await agentbox.create();
  const b = await agentbox.create();
  await assert.rejects(agentbox.create(), PoolExhausted);
  await b.destroy();

  runtime.nextExecResult = { timedOut: true, exitCode: 137, stdout: "partial" };
  await assert.rejects(a.exec(["sleep", "99"]), (err: unknown) => err instanceof ExecTimeout && err.result.stdout === "partial");

  await assert.rejects(a.exec(["true"], { timeoutMs: 10 ** 9 }), (err: unknown) => err instanceof AgentboxError && err.status === 400 && err.code === "ValidationError");
  await assert.rejects(a.writeFile("../x", "y"), (err: unknown) => err instanceof AgentboxError && err.code === "ValidationError");

  await a.destroy();
  await assert.rejects(a.exec(["true"]), (err: unknown) => err instanceof AgentboxError && err.status === 409 && err.code === "ConflictError");

  const wrong = new Agentbox({ baseUrl: agentbox["baseUrl"], apiKey: "nope" });
  await assert.rejects(wrong.list(), (err: unknown) => err instanceof AgentboxError && err.status === 401);
});
