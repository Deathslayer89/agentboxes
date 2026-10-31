// Measures agentbox from the outside, through the HTTP API, and prints a table for the README.
// Start the server first with a warm pool, for example POOL_SIZES=default:5, then: npm run bench
import { execFileSync } from "node:child_process";
import os from "node:os";
import Docker from "dockerode";
import { Agentbox } from "../sdk/src/index.js";

const agentbox = new Agentbox({ baseUrl: process.env.AGENTBOX_URL ?? "http://127.0.0.1:7788", ...(process.env.AGENTBOX_API_KEY ? { apiKey: process.env.AGENTBOX_API_KEY } : {}) });
const docker = new Docker();
const CLAIMS = Number(process.env.BENCH_CLAIMS ?? 20);
const COLD = Number(process.env.BENCH_COLD ?? 10);
const EXECS = Number(process.env.BENCH_EXECS ?? 30);
const IDLE = Number(process.env.BENCH_IDLE ?? 10);

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const row = (name: string, samples: number[]) =>
  `| ${name} | ${samples.length} | ${percentile(samples, 50).toFixed(1)} | ${percentile(samples, 95).toFixed(1)} | ${percentile(samples, 99).toFixed(1)} |`;

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await work();
  return [result, performance.now() - start];
}

// Waits until the default pool has a container ready, so every claim measures a hit, not a refill.
async function waitForPool(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const stats = await agentbox.stats();
    if ((stats.pools.default?.ready ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the default pool never became ready; start the server with POOL_SIZES=default:5");
}

const claims: number[] = [];
for (let i = 0; i < CLAIMS; i++) {
  await waitForPool();
  const [box, ms] = await timed(() => agentbox.create());
  if (box.info.startup.source !== "pool") throw new Error("expected a pool hit");
  claims.push(ms);
  await box.destroy();
}

const colds: number[] = [];
for (let i = 0; i < COLD; i++) {
  const [box, ms] = await timed(() => agentbox.create({ memoryMb: 256 }));
  if (box.info.startup.source !== "cold") throw new Error("expected a cold start");
  colds.push(ms);
  await box.destroy();
}

const execs: number[] = [];
const box = await agentbox.create();
for (let i = 0; i < EXECS; i++) {
  const [, ms] = await timed(() => box.exec(["python", "-c", "print(2+2)"]));
  execs.push(ms);
}
await box.destroy();

// Host memory held by idle sandboxes, from each container's cgroup, which under gVisor includes the sentry.
const idle = [];
for (let i = 0; i < IDLE; i++) idle.push(await agentbox.create({ memoryMb: 256 }));
await new Promise((resolve) => setTimeout(resolve, 2000));
let usedBytes = 0;
for (const c of await docker.listContainers({ filters: { label: ["agentbox=1"] } })) {
  const stats = (await docker.getContainer(c.Id).stats({ stream: false })) as { memory_stats?: { usage?: number } };
  usedBytes += stats.memory_stats?.usage ?? 0;
}
const perSandboxMb = usedBytes / idle.length / 1024 / 1024;
for (const b of idle) await b.destroy();

const runsc = (() => {
  try {
    return execFileSync("runsc", ["--version"]).toString().split("\n")[0];
  } catch {
    return "unknown";
  }
})();
const dockerVersion = (await docker.version()).Version;

console.log(`Machine: ${os.cpus()[0]?.model ?? "unknown cpu"}, ${os.cpus().length} threads, ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB RAM, Linux ${os.release()}, Docker ${dockerVersion}, ${runsc}`);
console.log();
console.log("| Measurement (HTTP round trip) | n | p50 ms | p95 ms | p99 ms |");
console.log("|---|---|---|---|---|");
console.log(row("create from warm pool", claims));
console.log(row("create cold (no pool)", colds));
console.log(row("exec `print(2+2)`", execs));
console.log();
console.log(`Idle sandbox memory on the host: ${perSandboxMb.toFixed(0)} MB each, about ${Math.floor(1024 / perSandboxMb)} sandboxes per GB of RAM (includes gVisor's sentry; the pool holds a few more).`);
