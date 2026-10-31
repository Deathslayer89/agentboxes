import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FakeClock } from "../../../src/clock.js";
import { loadConfig } from "../../../src/config.js";
import { createApp } from "../../../src/http/app.js";
import { CounterIdGenerator } from "../../../src/id.js";
import { InMemorySandboxRepository } from "../../../src/repositories/sandboxRepository.js";
import { InMemoryTemplateRepository } from "../../../src/repositories/templateRepository.js";
import { FakeRuntime } from "../../../src/runtime/fakeRuntime.js";
import { SandboxService } from "../../../src/services/sandboxService.js";
import { WarmPools } from "../../../src/services/warmPool.js";

// The real MCP server process over stdio, talking to the HTTP stack on a random port with the fake runtime.
const runtime = new FakeRuntime();
const service = new SandboxService(
  new InMemorySandboxRepository(),
  new InMemoryTemplateRepository(),
  runtime,
  loadConfig({ POOL_SIZES: "default:0" }),
  new FakeClock(new Date("2026-01-01T00:00:00Z")),
  new CounterIdGenerator("sbx_"),
  new WarmPools(),
);
let server: ServerType;
let client: Client;

const textOf = (result: unknown) => ((result as { content: Array<{ type: string; text: string }> }).content[0]?.text ?? "");

before(async () => {
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: createApp(service, { apiKey: "k1" }).fetch, hostname: "127.0.0.1", port: 0 }, (info) => resolve(info.port));
  });
  const root = resolve(import.meta.dirname, "../../..");
  const transport = new StdioClientTransport({
    command: resolve(root, "node_modules/.bin/tsx"),
    args: [resolve(root, "mcp/server.ts")],
    env: { ...process.env, AGENTBOX_URL: `http://127.0.0.1:${port}`, AGENTBOX_API_KEY: "k1", AGENTBOX_TTL_SECONDS: "120" } as Record<string, string>,
    cwd: root,
    stderr: "pipe",
  });
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
});

after(async () => {
  try {
    await client.close();
    // The MCP server destroys its sandbox when the client disconnects.
    for (let i = 0; i < 50 && service.list().length > 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(service.list().length, 0, "the session sandbox is destroyed on disconnect");
  } finally {
    server.close();
  }
});

test("the five tools are listed", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["read_file", "reset_sandbox", "run_code", "run_command", "write_file"]);
});

test("run_code writes the file and runs it in one sandbox that is reused across calls", async () => {
  const first = await client.callTool({ name: "run_code", arguments: { language: "python", code: "print(2+2)" } });
  assert.match(textOf(first), /exit code: 0\nstdout:\npython main.py/);
  assert.equal(service.list().length, 1);
  assert.equal(service.list()[0]?.limits.ttlSeconds, 120);
  const [container] = runtime.containers.values();
  assert.equal(container?.files.get("/workspace/main.py")?.toString(), "print(2+2)");

  const second = await client.callTool({ name: "run_command", arguments: { cmd: ["ls", "-la"] } });
  assert.match(textOf(second), /stdout:\nls -la/);
  assert.equal(service.list().length, 1, "the same sandbox served both calls");
});

test("write_file and read_file round trip; a bad path is a tool error, not a crash", async () => {
  await client.callTool({ name: "write_file", arguments: { path: "notes/todo.txt", content: "ship it" } });
  assert.equal(textOf(await client.callTool({ name: "read_file", arguments: { path: "notes/todo.txt" } })), "ship it");
  const bad = await client.callTool({ name: "read_file", arguments: { path: "../etc/passwd" } });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /ValidationError/);
});

test("after the sandbox is gone, the next call gets a new one; reset_sandbox forces that", async () => {
  await service.destroy("sbx_1");
  await client.callTool({ name: "run_command", arguments: { cmd: ["true"] } });
  assert.equal(service.list().filter((s) => s.status === "ready").map((s) => s.id).join(), "sbx_2");
  assert.match(textOf(await client.callTool({ name: "reset_sandbox", arguments: {} })), /destroyed sandbox sbx_2/);
  await client.callTool({ name: "run_command", arguments: { cmd: ["true"] } });
  assert.equal(service.list().filter((s) => s.status === "ready").map((s) => s.id).join(), "sbx_3");
});

test("a timed out command comes back as a tool error with the partial output", async () => {
  runtime.nextExecResult = { timedOut: true, exitCode: 137, stdout: "partial", durationMs: 500 };
  const result = await client.callTool({ name: "run_command", arguments: { cmd: ["sleep", "99"] } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /killed at the 500 ms deadline[\s\S]*partial/);
});
