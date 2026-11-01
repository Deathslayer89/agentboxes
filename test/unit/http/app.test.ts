import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "../../../src/clock.js";
import { loadConfig } from "../../../src/config.js";
import { createApp, type AppOptions } from "../../../src/http/app.js";
import { CounterIdGenerator } from "../../../src/id.js";
import { InMemorySandboxRepository } from "../../../src/repositories/sandboxRepository.js";
import { InMemoryTemplateRepository } from "../../../src/repositories/templateRepository.js";
import { FakeRuntime } from "../../../src/runtime/fakeRuntime.js";
import { SandboxService } from "../../../src/services/sandboxService.js";
import { WarmPools } from "../../../src/services/warmPool.js";

// HTTP layer against the fake runtime: routes, status codes and auth, no Docker.
function makeApp(options: AppOptions = {}, env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ POOL_SIZES: "default:0", ...env });
  const runtime = new FakeRuntime();
  const service = new SandboxService(
    new InMemorySandboxRepository(),
    new InMemoryTemplateRepository(),
    runtime,
    config,
    new FakeClock(new Date("2026-01-01T00:00:00Z")),
    new CounterIdGenerator("sbx_"),
    new WarmPools(),
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
  assert.equal(((await (await app.request("/sandboxes")).json()) as unknown[]).length, 0, "destroyed sandboxes are hidden by default");
  assert.equal(((await (await app.request("/sandboxes?all=true")).json()) as unknown[]).length, 1);
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
  const { app } = makeApp({ apiKeys: [{ name: "default", key: "s3cret" }] });
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await app.request("/sandboxes")).status, 401);
  assert.equal((await app.request("/sandboxes", { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await app.request("/sandboxes", { headers: { authorization: "Bearer s3cret-but-longer" } })).status, 401);
  assert.equal((await app.request("/sandboxes", { headers: { authorization: "Basic s3cret" } })).status, 401);
  assert.equal((await app.request("/sandboxes", { headers: { authorization: "Bearer s3cret" } })).status, 200);
  const created = await app.request("/sandboxes", { method: "POST", body: "{}" });
  assert.equal(created.status, 401);
});

test("PUT and GET files carry raw bytes; a missing path is a 400", async () => {
  const { app } = makeApp();
  const { id } = (await (await app.request("/sandboxes", { method: "POST", body: "{}" })).json()) as { id: string };
  const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
  const put = await app.request(`/sandboxes/${id}/files?path=bin/data`, { method: "PUT", body: bytes });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { path: "/workspace/bin/data", bytes: 6 });
  const get = await app.request(`/sandboxes/${id}/files?path=/workspace/bin/data`);
  assert.equal(get.status, 200);
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
  assert.equal((await app.request(`/sandboxes/${id}/files`, { method: "PUT", body: "x" })).status, 400);
  assert.equal((await app.request(`/sandboxes/${id}/files?path=../x`, { method: "PUT", body: "x" })).status, 400);
  assert.equal((await app.request(`/sandboxes/${id}/files?path=nope`)).status, 404);
});

// Minimal SSE parser for tests: returns [{event, data}] in order.
function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      return { event, data: JSON.parse(data) };
    });
}

test("exec/stream sends output chunks as events, then an exit event", async () => {
  const { app } = makeApp();
  const { id } = (await (await app.request("/sandboxes", { method: "POST", body: "{}" })).json()) as { id: string };
  const res = await app.request(`/sandboxes/${id}/exec/stream`, { method: "POST", body: JSON.stringify({ cmd: ["echo", "hi"] }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = parseSse(await res.text());
  assert.deepEqual(events, [
    { event: "stdout", data: "ech" },
    { event: "stdout", data: "o hi" },
    { event: "stderr", data: "" },
    { event: "exit", data: { exitCode: 0, durationMs: 1, timedOut: false, truncated: false } },
  ]);
  assert.equal((await app.request("/sandboxes/sbx_nope/exec/stream", { method: "POST", body: JSON.stringify({ cmd: ["true"] }) })).status, 404);
  assert.equal((await app.request(`/sandboxes/${id}/exec/stream`, { method: "POST", body: "{}" })).status, 400);
});

test("exec/stream reports a failure after the stream began as an error event", async () => {
  const { app, runtime } = makeApp();
  const { id } = (await (await app.request("/sandboxes", { method: "POST", body: "{}" })).json()) as { id: string };
  runtime.containers.clear(); // the container vanished under the server
  const res = await app.request(`/sandboxes/${id}/exec/stream`, { method: "POST", body: JSON.stringify({ cmd: ["true"] }) });
  assert.equal(res.status, 200);
  const [only] = parseSse(await res.text());
  assert.equal(only?.event, "error");
  assert.equal((only?.data as { error: string }).error, "ConflictError");
});

test("GET /stats reports live sandboxes and the pool", async () => {
  const { app } = makeApp();
  await app.request("/sandboxes", { method: "POST", body: "{}" });
  assert.deepEqual(await (await app.request("/stats")).json(), { sandboxes: { live: 1, max: 20 }, pools: {} });
  assert.deepEqual(await (await app.request("/templates")).json(), [{ name: "default", image: "python:3.12-slim" }]);
  const { app: locked } = makeApp({ apiKeys: [{ name: "default", key: "k" }] });
  assert.equal((await locked.request("/stats")).status, 401);
  assert.equal((await locked.request("/templates")).status, 401);
});

test("egress log route and network in the view", async () => {
  const { app } = makeApp({}, { OPENAI_API_KEY: "sk-test" });
  const created = await app.request("/sandboxes", { method: "POST", body: JSON.stringify({ secrets: { "api.openai.com": "OPENAI_API_KEY" } }) });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { id: string; network: unknown };
  assert.deepEqual(body.network, { allowHosts: ["api.openai.com"], secretHosts: ["api.openai.com"] });
  assert.deepEqual(await (await app.request(`/sandboxes/${body.id}/egress-log`)).json(), { allowHosts: ["api.openai.com"], denied: [] });
  assert.equal((await app.request("/sandboxes", { method: "POST", body: JSON.stringify({ secrets: { "api.openai.com": "NOPE" } }) })).status, 400);
  assert.equal((await app.request("/sandboxes", { method: "POST", body: JSON.stringify({ allowHosts: ["bad host"] }) })).status, 400);
});

test("PUT and GET archive carry tar bytes; the path defaults to /workspace", async () => {
  const { app } = makeApp();
  const { id } = (await (await app.request("/sandboxes", { method: "POST", body: "{}" })).json()) as { id: string };
  const put = await app.request(`/sandboxes/${id}/archive`, { method: "PUT", body: Buffer.from("tar!") });
  assert.deepEqual(await put.json(), { path: "/workspace", bytes: 4 });
  const get = await app.request(`/sandboxes/${id}/archive?path=/workspace/`);
  assert.equal(get.headers.get("content-type"), "application/x-tar");
  assert.equal(Buffer.from(await get.arrayBuffer()).toString(), "tar!");
  assert.equal((await app.request(`/sandboxes/${id}/archive?path=../`, { method: "PUT", body: "x" })).status, 400);
});

test("the request log gets one line per request, except health probes", async () => {
  const lines: string[] = [];
  const { app } = makeApp({ apiKeys: [{ name: "team", key: "k1" }], log: (line) => lines.push(line) });
  await app.request("/health");
  await app.request("/sandboxes", { method: "POST", headers: { authorization: "Bearer k1" }, body: "{}" });
  await app.request("/sandboxes", { headers: { authorization: "Bearer wrong" } });
  assert.deepEqual(lines.map((line) => line.replace(/\d+ ms/, "N ms")), ["POST /sandboxes 201 N ms team", "GET /sandboxes 401 N ms -"]);
});

test("POST /sandboxes/:id/extend returns the record with a later expiry", async () => {
  const { app } = makeApp();
  const created = (await (await app.request("/sandboxes", { method: "POST", body: "{}" })).json()) as { id: string; expiresAt: string };
  const extended = (await (await app.request(`/sandboxes/${created.id}/extend`, { method: "POST", body: JSON.stringify({ ttlSeconds: 1200 }) })).json()) as { expiresAt: string };
  assert.ok(new Date(extended.expiresAt) > new Date(created.expiresAt));
  assert.equal((await app.request(`/sandboxes/${created.id}/extend`, { method: "POST", body: JSON.stringify({ ttlSeconds: 0 }) })).status, 400);
});

test("GET /metrics counts what the service did", async () => {
  const { app } = makeApp();
  const { id } = (await (await app.request("/sandboxes", { method: "POST", body: "{}" })).json()) as { id: string };
  await app.request(`/sandboxes/${id}/exec`, { method: "POST", body: JSON.stringify({ cmd: ["true"] }) });
  await app.request(`/sandboxes/${id}`, { method: "DELETE" });
  const res = await app.request("/metrics");
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const text = await res.text();
  assert.match(text, /agentbox_creates_total\{source="cold"\} 1\n/);
  assert.match(text, /agentbox_exec_duration_seconds_count 1\n/);
  assert.match(text, /agentbox_removals_total\{reason="destroyed"\} 1\n/);
  assert.match(text, /agentbox_sandboxes_live 0\n/);
  const { app: locked } = makeApp({ apiKeys: [{ name: "default", key: "k" }] });
  assert.equal((await locked.request("/metrics")).status, 401);
});

test("each key sees only its own sandboxes and is held to its own limits", async () => {
  const { app } = makeApp({ apiKeys: [{ name: "a", key: "ka", maxSandboxes: 1 }, { name: "b", key: "kb", maxMemoryMb: 600 }] }, { AGENTBOX_API_KEYS: "a:ka:1,b:kb::600" });
  const asA = { authorization: "Bearer ka" };
  const asB = { authorization: "Bearer kb" };
  const created = await app.request("/sandboxes", { method: "POST", body: "{}", headers: asA });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  assert.equal((await app.request("/sandboxes", { method: "POST", body: "{}", headers: asA })).status, 429, "key a is capped at one sandbox");

  assert.equal((await app.request(`/sandboxes/${id}`, { headers: asA })).status, 200);
  assert.equal((await app.request(`/sandboxes/${id}`, { headers: asB })).status, 404, "another key's sandbox looks like it does not exist");
  assert.equal((await app.request(`/sandboxes/${id}`, { method: "DELETE", headers: asB })).status, 404);
  assert.equal(((await (await app.request("/sandboxes", { headers: asB })).json()) as unknown[]).length, 0);

  assert.equal((await app.request("/sandboxes", { method: "POST", body: JSON.stringify({ memoryMb: 512 }), headers: asB })).status, 201);
  const over = await app.request("/sandboxes", { method: "POST", body: JSON.stringify({ memoryMb: 256 }), headers: asB });
  assert.equal(over.status, 429, "key b would exceed 600 MB in total");
  assert.match(((await over.json()) as { message: string }).message, /memory limit/);
});
