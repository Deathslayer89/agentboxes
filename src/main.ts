import { serve } from "@hono/node-server";
import Docker from "dockerode";
import { SystemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { RuntimeUnavailableError } from "./errors.js";
import { createApp } from "./http/app.js";
import { RandomIdGenerator } from "./id.js";
import { DEFAULT_TEMPLATE } from "./models/template.js";
import { InMemorySandboxRepository } from "./repositories/sandboxRepository.js";
import { EgressProxyManager } from "./runtime/egressProxy.js";
import { DockerTemplateRepository } from "./repositories/templateRepository.js";
import { GvisorDockerRuntime } from "./runtime/gvisorDockerRuntime.js";
import { SandboxService } from "./services/sandboxService.js";
import { WarmPool, WarmPools } from "./services/warmPool.js";

const config = loadConfig();
const docker = new Docker();
const runtime = new GvisorDockerRuntime(docker, config.image, config.maxOutputBytes, config.maxFileBytes, new EgressProxyManager(docker));
const templates = new DockerTemplateRepository(docker);

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

// One pool per template in POOL_SIZES. A template that is not built yet is a startup error, not a silent miss.
const pools = new WarmPools();
const known = new Map((await templates.list()).map((t) => [t.name, t.image]));
known.set(DEFAULT_TEMPLATE, config.image);
for (const [template, size] of Object.entries(config.poolSizes)) {
  const image = known.get(template);
  if (image === undefined) {
    console.error(`agentbox: POOL_SIZES names template "${template}" but no such image exists; build it with: npm run agentbox -- template build ${template} ./Dockerfile`);
    process.exit(1);
  }
  pools.add(template, new WarmPool(runtime, config.defaults, size, image, template));
}

const service = new SandboxService(
  new InMemorySandboxRepository(),
  templates,
  runtime,
  config,
  new SystemClock(),
  new RandomIdGenerator("sbx_"),
  pools,
);

// Clean up containers left behind by a previous run, then fill the pool, before taking requests.
const leftovers = await service.reap();
if (leftovers.orphans.length > 0) console.log(`agentbox: removed ${leftovers.orphans.length} orphaned container(s)`);
for (const [template, s] of Object.entries(pools.stats())) console.log(`agentbox: warm pool ${template}: ${s.ready} of ${s.size} ready`);

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
  await Promise.all([pools.drain(), ...service.list().map((s) => service.destroy(s.id).catch(() => {}))]);
  await runtime.shutdown();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
