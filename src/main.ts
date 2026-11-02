import { serve } from "@hono/node-server";
import Docker from "dockerode";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SystemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { RuntimeUnavailableError } from "./errors.js";
import { createApp } from "./http/app.js";
import { RandomIdGenerator } from "./id.js";
import { logFor } from "./log.js";
import { DEFAULT_TEMPLATE } from "./models/template.js";
import { SqliteStore } from "./repositories/sqliteStore.js";
import { EgressProxyManager } from "./runtime/egressProxy.js";
import { FirecrackerRuntime } from "./runtime/firecrackerRuntime.js";
import { DockerTemplateRepository } from "./repositories/templateRepository.js";
import { GvisorDockerRuntime } from "./runtime/gvisorDockerRuntime.js";
import { SandboxService } from "./services/sandboxService.js";
import { WarmPool, WarmPools } from "./services/warmPool.js";

const log = logFor("server");
const config = loadConfig();
const docker = new Docker();
const store = new SqliteStore(config.dbPath);
const runtime =
  config.runtime === "firecracker"
    ? new FirecrackerRuntime(dirname(config.dbPath), config.defaults, config.maxOutputBytes)
    : new GvisorDockerRuntime(docker, config.runtime, config.image, config.maxOutputBytes, config.maxFileBytes, config.maxArchiveBytes, new EgressProxyManager(docker, store.settings));
const templates = new DockerTemplateRepository(docker);

// Refuse to start without gVisor instead of silently running on runc.
try {
  await runtime.init();
} catch (e) {
  if (e instanceof RuntimeUnavailableError) {
    log.fatal(e.message);
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
    log.fatal({ template }, `POOL_SIZES names template "${template}" but no such image exists; build it with: npm run agentbox -- template build ${template} ./Dockerfile`);
    process.exit(1);
  }
  pools.add(template, new WarmPool(runtime, config.defaults, size, image, template));
}

const service = new SandboxService(
  store.sandboxes,
  templates,
  runtime,
  config,
  new SystemClock(),
  new RandomIdGenerator("sbx_"),
  pools,
);

// Take back the sandboxes of the previous run, drop what did not survive, then fill the pool, before taking requests.
const { adopted, lost } = await service.adopt();
if (adopted.length > 0 || lost.length > 0) log.info({ adopted: adopted.length, lost: lost.length }, "sandboxes from the previous run checked");
await service.reap();
for (const [template, s] of Object.entries(pools.stats())) log.info({ template, ready: s.ready, size: s.size }, "warm pool filled");

// The service logs each expiry, orphan and dead pool container itself.
const reaper = setInterval(() => {
  service.reap().catch((err: unknown) => log.error({ err }, "reaper pass failed"));
}, config.reaperIntervalMs);

if (config.apiKeys.length === 0) {
  log.warn("no API key is set, so auth is off; set AGENTBOX_API_KEY and HOST=0.0.0.0 to serve other machines");
}
// The pid next to the database, so `npm stop` can find the server behind the npm wrapper; written once the port is bound, so a second server that fails to bind cannot overwrite it.
const pidFile = join(dirname(config.dbPath), "agentbox.pid");

const server = serve({ fetch: createApp(service, { apiKeys: config.apiKeys, logger: logFor("http") }).fetch, hostname: config.host, port: config.port }, (info) => {
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, `${process.pid}\n`);
  log.info({ url: `http://${info.address}:${info.port}`, image: config.image, runtime: runtime.runtimeName, keys: config.apiKeys.map((k) => k.name), db: config.dbPath }, "agentbox listening");
});

// Sandboxes keep running: their records are on disk and the next start adopts them. Only the pool is drained.
async function shutdown(signal: string): Promise<void> {
  log.info({ signal, running: service.list().length }, "shutting down; sandboxes keep running for the next start");
  clearInterval(reaper);
  server.close();
  await pools.drain();
  await runtime.shutdown();
  store.close();
  rmSync(pidFile, { force: true });
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
