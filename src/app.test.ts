import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { createApp, type AppOptions } from "./http/app.js";
import { CounterIdGenerator } from "./id.js";
import { InMemorySandboxRepository } from "./repositories/sandboxRepository.js";
import { FakeRuntime } from "./runtime/fakeRuntime.js";
import { SandboxService } from "./services/sandboxService.js";

// HTTP layer against the fake runtime: routes, status codes and auth, no Docker.
function makeApp(options: AppOptions = {}, env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig(env);
  const runtime = new FakeRuntime();
  const service = new SandboxService(
    new InMemorySandboxRepository(),
    runtime,
    config,
    new FakeClock(new Date("2026-01-01T00:00:00Z")),
    new CounterIdGenerator("sbx_"),
  );
  return { app: createApp(service, options), service, runtime };
}

test("create, exec, get, list, destroy over HTTP", async () => {
  const { app } = makeApp();
  const created = await app.request("/sandboxes", { method: "POST", body: "{}" });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  assert.equal(id, "sbx_1");

  const exec = await app.request(`/sandboxes/${id}/exec`, { method: "POST", body: JSON.stringify({ cmd: ["echo", "hi"] }) });
  assert.equal(exec.status, 200);
  assert.equal(((await exec.json()) as { stdout: string }).stdout, "echo hi");

  assert.equal((await app.request(`/sandboxes/${id}`)).status, 200);
  assert.equal(((await (await app.request("/sandboxes")).json()) as unknown[]).length, 1);
  assert.equal((await app.request(`/sandboxes/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await app.request(`/sandboxes/${id}/exec`, { method: "POST", body: JSON.stringify({ cmd: ["true"] }) })).status, 409);
});

test("errors map to status codes: bad JSON 400, unknown id 404", async () => {
  const { app } = makeApp();
  assert.equal((await app.request("/sandboxes", { method: "POST", body: "{not json" })).status, 400);
  assert.equal((await app.request("/sandboxes", { method: "POST", body: JSON.stringify({ memoryMb: "big" }) })).status, 400);
  assert.equal((await app.request("/sandboxes/sbx_nope")).status, 404);
});

test("without an API key every route is open", async () => {
  const { app } = makeApp();
  assert.equal((await app.request("/sandboxes")).status, 200);
});

test("with an API key, /sandboxes needs the exact bearer token and /health stays open", async () => {
  const { app } = makeApp({ apiKey: "s3cret" });
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await app.request("/sandboxes")).status, 401);
  assert.equal((await app.request("/sandboxes", { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await app.request("/sandboxes", { headers: { authorization: "Bearer s3cret-but-longer" } })).status, 401);
  assert.equal((await app.request("/sandboxes", { headers: { authorization: "Basic s3cret" } })).status, 401);
  assert.equal((await app.request("/sandboxes", { headers: { authorization: "Bearer s3cret" } })).status, 200);
  const created = await app.request("/sandboxes", { method: "POST", body: "{}" });
  assert.equal(created.status, 401);
});
