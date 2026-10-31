// Runs against real Firecracker on a KVM host; skipped when firecracker/setup.sh has not been run.
//   npm run test:firecracker
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test, { after, before } from "node:test";
import { SystemClock } from "../../src/clock.js";
import { loadConfig } from "../../src/config.js";
import { RandomIdGenerator } from "../../src/id.js";
import { InMemorySandboxRepository } from "../../src/repositories/sandboxRepository.js";
import { InMemoryTemplateRepository } from "../../src/repositories/templateRepository.js";
import { FirecrackerRuntime } from "../../src/runtime/firecrackerRuntime.js";
import { SandboxService } from "../../src/services/sandboxService.js";
import { WarmPools } from "../../src/services/warmPool.js";

const ready = existsSync("data/firecracker/rootfs.ext4") && existsSync("/dev/kvm");
const config = loadConfig({ ...process.env, DEFAULT_TTL_SECONDS: "120", POOL_SIZES: "default:0" });
const runtime = new FirecrackerRuntime("data", config.defaults, config.maxOutputBytes);
const service = new SandboxService(new InMemorySandboxRepository(), new InMemoryTemplateRepository(), runtime, config, new SystemClock(), new RandomIdGenerator("sbxfc_"), new WarmPools());

before(async () => {
  if (!ready) return;
  const t = Date.now();
  await runtime.init();
  console.log(`init (snapshot taken if missing): ${Date.now() - t} ms`);
});

after(async () => {
  if (ready) await runtime.shutdown();
});

test("a default-sized sandbox restores from the snapshot and runs python", { skip: !ready }, async () => {
  const box = await service.create();
  try {
    assert.ok(box.startup.ms < 2_000, `restore took ${box.startup.ms} ms`);
    const r = await service.exec(box.id, { cmd: ["python", "-c", "import os; print(2+2, os.getuid())"] });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), "4 65534");
    assert.match((await service.exec(box.id, { cmd: ["uname", "-r"] })).stdout, /^6\.1\./);
    console.log(`restore ${box.startup.ms} ms, exec ${r.durationMs} ms`);
  } finally {
    await service.destroy(box.id);
  }
});

test("two restored sandboxes are independent and get different randomness", { skip: !ready }, async () => {
  const a = await service.create();
  const b = await service.create();
  try {
    await service.writeFile(a.id, "only-in-a.txt", Buffer.from("a"));
    assert.notEqual((await service.exec(b.id, { cmd: ["cat", "only-in-a.txt"] })).exitCode, 0);
    const randomOf = async (id: string) => (await service.exec(id, { cmd: ["python", "-c", "import os; print(os.urandom(8).hex())"] })).stdout.trim();
    assert.notEqual(await randomOf(a.id), await randomOf(b.id));
  } finally {
    await service.destroy(a.id);
    await service.destroy(b.id);
  }
});

test("files, archives, cwd and env, timeout kill, and output limits work over the console", { skip: !ready }, async () => {
  const box = await service.create();
  try {
    const bytes = Buffer.concat([Buffer.from("print('from file')\n"), Buffer.from([0, 255, 254])]);
    await service.writeFile(box.id, "nested/main.py", bytes);
    assert.deepEqual(await service.readFile(box.id, "nested/main.py"), bytes);
    const r = await service.exec(box.id, { cmd: ["sh", "-c", "pwd; echo $GREETING"], cwd: "nested", env: { GREETING: "hi" } });
    assert.equal(r.stdout, "/workspace/nested\nhi\n");
    const slow = await service.exec(box.id, { cmd: ["sleep", "30"], timeoutMs: 1_000 });
    assert.equal(slow.timedOut, true);
    assert.equal((await service.exec(box.id, { cmd: ["echo", "alive"] })).stdout.trim(), "alive");
    const tar = await service.getArchive(box.id, "nested");
    await service.putArchive(box.id, "copy", tar);
    assert.deepEqual(await service.readFile(box.id, "copy/main.py"), bytes);
    assert.notEqual((await service.exec(box.id, { cmd: ["sh", "-c", "head -c 1500M /dev/zero > big"] })).exitCode, 0, "the workspace is bounded");
  } finally {
    await service.destroy(box.id);
  }
});

test("a custom size boots cold, which is slower than a restore", { skip: !ready }, async () => {
  const box = await service.create({ memoryMb: 256 });
  try {
    assert.equal(box.startup.source, "cold");
    const r = await service.exec(box.id, { cmd: ["python", "-c", "print(2+2)"] });
    assert.equal(r.stdout.trim(), "4");
    console.log(`cold boot ${box.startup.ms} ms`);
  } finally {
    await service.destroy(box.id);
  }
});
