/**
 * Runs against real Docker with gVisor registered. Not part of `npm test`.
 *   npm run test:integration
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import os from "node:os";
import test, { after, before } from "node:test";
import Docker from "dockerode";
import { SystemClock } from "../src/clock.js";
import { loadConfig } from "../src/config.js";
import { RandomIdGenerator } from "../src/id.js";
import { InMemorySandboxRepository } from "../src/repositories/sandboxRepository.js";
import { DockerTemplateRepository } from "../src/repositories/templateRepository.js";
import { GvisorDockerRuntime } from "../src/runtime/gvisorDockerRuntime.js";
import { SandboxService } from "../src/services/sandboxService.js";
import { WarmPool, WarmPools } from "../src/services/warmPool.js";

const config = loadConfig({ ...process.env, DEFAULT_TTL_SECONDS: "120" });
const docker = new Docker();
const runtime = new GvisorDockerRuntime(docker, config.image, config.maxOutputBytes, config.maxFileBytes);
const templates = new DockerTemplateRepository(docker);
const service = new SandboxService(new InMemorySandboxRepository(), templates, runtime, config, new SystemClock(), new RandomIdGenerator("sbxtest_"), new WarmPools());

let id: string;

before(async () => {
  await runtime.init();
  id = (await service.create()).id;
});

after(async () => {
  await service.destroy(id);
});

const run = (cmd: string[], timeoutMs?: number) => service.exec(id, timeoutMs === undefined ? { cmd } : { cmd, timeoutMs });

test("F2: python runs and prints", async () => {
  const r = await run(["python", "-c", "print(2+2)"]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), "4");
  assert.equal(r.timedOut, false);
});

test("F2: stderr and the exit code come back", async () => {
  const r = await run(["python", "-c", "import sys; print('bad', file=sys.stderr); sys.exit(3)"]);
  assert.equal(r.exitCode, 3);
  assert.equal(r.stderr.trim(), "bad");
});

test("S3: the per-exec timeout kills the command and the sandbox survives", async () => {
  const r = await run(["sleep", "30"], 500);
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 5_000, `took ${r.durationMs} ms`);
  assert.equal((await run(["echo", "still alive"])).stdout.trim(), "still alive");
});

test("S1: the kernel inside is gVisor's, not the host's", async () => {
  const r = await run(["uname", "-r"]);
  assert.match(r.stdout, /gvisor/, `uname -r printed ${r.stdout}`);
  assert.notEqual(r.stdout.trim(), os.release());
});

test("S2: no network", async () => {
  const r = await run(["python", "-c", "import socket; socket.create_connection(('1.1.1.1', 80), timeout=3)"]);
  assert.notEqual(r.exitCode, 0);
});

test("S4: root is read-only, /workspace and /tmp are writable", async () => {
  assert.notEqual((await run(["touch", "/etc/x"])).exitCode, 0);
  assert.equal((await run(["sh", "-c", "echo hi > /workspace/a.txt && cat /workspace/a.txt"])).stdout.trim(), "hi");
  assert.equal((await run(["sh", "-c", "echo hi > /tmp/a.txt && cat /tmp/a.txt"])).stdout.trim(), "hi");
});

test("S5: not root, and no capabilities", async () => {
  assert.equal((await run(["id", "-u"])).stdout.trim(), "65534");
  const caps = await run(["sh", "-c", "grep CapEff /proc/self/status"]);
  assert.match(caps.stdout, /CapEff:\s+0000000000000000/);
});

test("S6: no docker socket, and the host's environment is not visible", async () => {
  assert.notEqual((await run(["test", "-e", "/var/run/docker.sock"])).exitCode, 0);
  const env = await run(["env"]);
  assert.doesNotMatch(env.stdout, /AGENTBOX|DOCKER_HOST|^PATH=.*\/home\//m);
});

test("F3/F4: destroy, then exec is a conflict and the record says destroyed", async () => {
  const extra = await service.create();
  await service.destroy(extra.id);
  assert.equal(service.get(extra.id).status, "destroyed");
  await assert.rejects(service.exec(extra.id, { cmd: ["true"] }));
});

test("F5: a container the server does not know about is removed by the reaper", async () => {
  const orphan = await runtime.start("sbxtest_orphan", config.defaults, config.image);
  const { orphans } = await service.reap();
  assert.ok(orphans.includes("sbxtest_orphan"));
  const still = (await runtime.listManaged()).some((c) => c.handle === orphan);
  assert.equal(still, false);
});

test("F7: a file written through the API is there for the next exec, and comes back byte for byte", async () => {
  const bytes = Buffer.concat([Buffer.from("print('from file')\n"), Buffer.from([0, 255, 254])]);
  await service.writeFile(id, "nested/dir/main.py", bytes);
  assert.deepEqual(await service.readFile(id, "nested/dir/main.py"), bytes);
  const r = await run(["head", "-c", "19", "nested/dir/main.py"]);
  assert.equal(r.stdout, "print('from file')\n");
  await assert.rejects(service.readFile(id, "nested/dir/missing.py"));
});

test("F7: a file bigger than MAX_FILE_BYTES is refused on read, and exec output over the cap is flagged", async () => {
  await run(["sh", "-c", `head -c ${config.maxFileBytes + 1} /dev/zero > big.bin`]);
  await assert.rejects(service.readFile(id, "big.bin"), /larger than/);
  const r = await run(["sh", "-c", `head -c ${config.maxOutputBytes + 1} /dev/zero`]);
  assert.equal(r.truncated, true);
  assert.equal(r.stdout.length, config.maxOutputBytes);
});

test("F6: output chunks arrive while the command is still running", async () => {
  const arrivals: number[] = [];
  const startedAt = Date.now();
  const r = await service.exec(
    id,
    { cmd: ["python", "-c", "import time\nfor i in range(3):\n    print(i)\n    time.sleep(0.3)"] },
    () => arrivals.push(Date.now() - startedAt),
  );
  assert.equal(r.stdout, "0\n1\n2\n");
  assert.ok(arrivals.length >= 3, `got ${arrivals.length} chunks`);
  assert.ok((arrivals[0] ?? Infinity) < r.durationMs / 2, `first chunk at ${arrivals[0]} ms, command took ${r.durationMs} ms`);
});

test("P1/P2: a sandbox from the warm pool is ready in well under 100 ms; a cold one takes longer", async () => {
  const warm = new WarmPool(runtime, config.defaults, 2, config.image, "default");
  const pools = new WarmPools();
  pools.add("default", warm);
  const pooled = new SandboxService(new InMemorySandboxRepository(), templates, runtime, config, new SystemClock(), new RandomIdGenerator("sbxpool_"), pools);
  await warm.fill();
  try {
    const a = await pooled.create();
    const b = await pooled.create();
    assert.equal(a.startup.source, "pool");
    assert.equal(b.startup.source, "pool");
    assert.ok(a.startup.ms < 100, `pool claim took ${a.startup.ms} ms`);
    assert.equal((await pooled.exec(a.id, { cmd: ["python", "-c", "print(2+2)"] })).stdout.trim(), "4");
    const cold = await pooled.create({ memoryMb: 256 });
    assert.equal(cold.startup.source, "cold");
    assert.ok(cold.startup.ms > a.startup.ms, `cold ${cold.startup.ms} ms vs pool ${a.startup.ms} ms`);
    console.log(`pool claim ${a.startup.ms} ms, cold start ${cold.startup.ms} ms`);
    await warm.fill();
    assert.equal(warm.stats().ready, 2);
    for (const s of pooled.list()) await pooled.destroy(s.id);
  } finally {
    await warm.drain();
  }
});

test("F8/F9: a template built from a Dockerfile shows up in the list and its files are inside the sandbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-tpl-"));
  writeFileSync(join(dir, "Dockerfile"), `FROM ${config.image}\nRUN echo "hello from the template" > /opt/template.txt\n`);
  const lines: string[] = [];
  await templates.build("inttest", join(dir, "Dockerfile"), (line) => lines.push(line));
  try {
    assert.ok(lines.some((l) => l.includes("hello from the template")), lines.join("\n"));
    assert.ok((await service.listTemplates()).some((t) => t.name === "inttest"));
    const box = await service.create({ template: "inttest" });
    assert.equal(box.template, "inttest");
    assert.equal((await service.exec(box.id, { cmd: ["cat", "/opt/template.txt"] })).stdout.trim(), "hello from the template");
    await service.destroy(box.id);
    await assert.rejects(service.create({ template: "never-built" }), /unknown template/);
  } finally {
    await docker.getImage("agentbox/inttest:latest").remove({ force: true }).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
