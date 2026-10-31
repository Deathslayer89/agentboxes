import { serve } from "@hono/node-server";
import Docker from "dockerode";
import { SystemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { RuntimeUnavailableError } from "./errors.js";
import { createApp } from "./http/app.js";
import { RandomIdGenerator } from "./id.js";
import { InMemorySandboxRepository } from "./repositories/sandboxRepository.js";
import { GvisorDockerRuntime } from "./runtime/gvisorDockerRuntime.js";
import { SandboxService } from "./services/sandboxService.js";

const config = loadConfig();
const runtime = new GvisorDockerRuntime(new Docker(), config.image, config.maxOutputBytes, config.maxFileBytes);

// Refuse to start without gVisor instead of silently running on runc.
try {
  await runtime.init();
} catch (e) {
  if (e instanceof RuntimeUnavailableError) {
    console.error(`agentbox: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

const service = new SandboxService(
  new InMemorySandboxRepository(),
  runtime,
  config,
  new SystemClock(),
  new RandomIdGenerator("sbx_"),
);

// Clean up containers left behind by a previous run before taking requests.
const leftovers = await service.reap();
if (leftovers.orphans.length > 0) console.log(`agentbox: removed ${leftovers.orphans.length} orphaned container(s)`);

const reaper = setInterval(() => {
  service
    .reap()
    .then(({ expired, orphans }) => {
      if (expired.length > 0) console.log(`reaper: expired ${expired.join(", ")}`);
      if (orphans.length > 0) console.log(`reaper: removed orphans ${orphans.join(", ")}`);
    })
    .catch((err) => console.error("reaper:", err));
}, config.reaperIntervalMs);

if (config.apiKey === undefined) {
  console.log("agentbox: AGENTBOX_API_KEY is not set, so auth is off and only loopback is served");
}
const appOptions = config.apiKey === undefined ? {} : { apiKey: config.apiKey };
const server = serve({ fetch: createApp(service, appOptions).fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`agentbox listening on http://${info.address}:${info.port} (image ${config.image}, runtime runsc)`);
});

/**
 * State is in memory, so after a restart these sandboxes would be orphans anyway;
 * remove them now rather than leaving containers running.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`agentbox: ${signal} received, destroying sandboxes`);
  clearInterval(reaper);
  server.close();
  await Promise.all(service.list().map((s) => service.destroy(s.id).catch(() => {})));
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
