// Starts the HTTP app on a random port with the fake runtime, prints the port, and runs until stdin closes.
// Used by tests written in other languages, such as the Python SDK's.
import { serve } from "@hono/node-server";
import { FakeClock } from "../../src/clock.js";
import { loadConfig } from "../../src/config.js";
import { createApp } from "../../src/http/app.js";
import { CounterIdGenerator } from "../../src/id.js";
import { InMemorySandboxRepository } from "../../src/repositories/sandboxRepository.js";
import { InMemoryTemplateRepository } from "../../src/repositories/templateRepository.js";
import { FakeRuntime } from "../../src/runtime/fakeRuntime.js";
import { SandboxService } from "../../src/services/sandboxService.js";
import { WarmPools } from "../../src/services/warmPool.js";

const config = loadConfig({ POOL_SIZES: "default:0", MAX_SANDBOXES: process.env.MAX_SANDBOXES ?? "20" });
const service = new SandboxService(
  new InMemorySandboxRepository(),
  new InMemoryTemplateRepository(),
  new FakeRuntime(),
  config,
  new FakeClock(new Date("2026-01-01T00:00:00Z")),
  new CounterIdGenerator("sbx_"),
  new WarmPools(),
);
const apiKey = process.env.FAKE_API_KEY;
const server = serve({ fetch: createApp(service, apiKey ? { apiKeys: [{ name: "default", key: apiKey }] } : {}).fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
  process.stdout.write(`${info.port}\n`);
});
process.stdin.resume();
process.stdin.on("end", () => {
  server.close();
  process.exit(0);
});
