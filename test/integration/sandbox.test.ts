/**
 * Runs against real Docker with gVisor registered. Not part of `npm test`.
 *   npm run test:integration
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import os from "node:os";
import test, { after, before } from "node:test";
import Docker from "dockerode";
import { SystemClock } from "../../src/clock.js";
import { loadConfig } from "../../src/config.js";
import { RandomIdGenerator } from "../../src/id.js";
import { InMemorySettings } from "../../src/repositories/inMemorySettings.js";
import { InMemorySandboxRepository } from "../../src/repositories/sandboxRepository.js";
import { SqliteStore } from "../../src/repositories/sqliteStore.js";
import { EgressProxyManager, LABEL_NETWORK } from "../../src/runtime/egressProxy.js";
import { DockerTemplateRepository } from "../../src/repositories/templateRepository.js";
import { GvisorDockerRuntime } from "../../src/runtime/gvisorDockerRuntime.js";
import { SandboxService } from "../../src/services/sandboxService.js";
import { WarmPool, WarmPools } from "../../src/services/warmPool.js";

const config = loadConfig({ ...process.env, DEFAULT_TTL_SECONDS: "120" });
const docker = new Docker();
const runtime = new GvisorDockerRuntime(docker, config.runtime, config.image, config.maxOutputBytes, config.maxFileBytes, config.maxArchiveBytes, new EgressProxyManager(docker, new InMemorySettings()));
const templates = new DockerTemplateRepository(docker);
const service = new SandboxService(new InMemorySandboxRepository(), templates, runtime, config, new SystemClock(), new RandomIdGenerator("sbxtest_"), new WarmPools());

let id: string;

before(async () => {
  await runtime.init();
  assert.match(runtime.runtimeName, /^runsc/, "auto resolved to a gVisor runtime");
  console.log(`runtime: ${runtime.runtimeName}`);
  id = (await service.create()).id;
});

after(async () => {
  await service.destroy(id);
  await runtime.shutdown();
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

test("S4: root is read-only, /workspace and /tmp are writable, and a script there can be executed", async () => {
  assert.notEqual((await run(["touch", "/etc/x"])).exitCode, 0);
  assert.equal((await run(["sh", "-c", "echo hi > /workspace/a.txt && cat /workspace/a.txt"])).stdout.trim(), "hi");
  assert.equal((await run(["sh", "-c", "echo hi > /tmp/a.txt && cat /tmp/a.txt"])).stdout.trim(), "hi");
  // Docker mounts tmpfs noexec by default, which would break every script npm or pip installs.
  const script = await run(["sh", "-c", "printf '#!/bin/sh\\necho ran\\n' > /workspace/t.sh && chmod +x /workspace/t.sh && /workspace/t.sh && cp /workspace/t.sh /tmp/t.sh && /tmp/t.sh"]);
  assert.equal(script.stdout, "ran\nran\n", script.stderr);
});

test("S5: not root, and no capabilities", async () => {
  assert.equal((await run(["id", "-u"])).stdout.trim(), "65534");
  const caps = await run(["sh", "-c", "grep CapEff /proc/self/status"]);
  assert.match(caps.stdout, /CapEff:\s+0000000000000000/);
});

test("S6: no docker socket, and the host's environment is not visible", async () => {
  assert.notEqual((await run(["test", "-e", "/var/run/docker.sock"])).exitCode, 0);
  const env = await run(["env"]);
  // AGENTBOX_EXEC_ID is the per-command marker the server plants on purpose; nothing else of the host's may show.
  assert.doesNotMatch(env.stdout, /AGENTBOX_(?!EXEC_ID=)|DOCKER_HOST|^PATH=.*\/home\//m);
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

// Needs internet access: the proxy fetches from pypi.org and httpbin.org.
const fetchStatus = (svc: SandboxService, boxId: string, url: string) =>
  svc.exec(boxId, { cmd: ["python", "-c", `import urllib.request\nprint(urllib.request.urlopen(${JSON.stringify(url)}, timeout=15).status)`], timeoutMs: 30_000 });

test("N1/N2/N3: an allowlisted sandbox reaches only the listed hosts; refusals are logged; metadata and the host stay unreachable", async () => {
  const box = await service.create({ allowHosts: ["pypi.org", "files.pythonhosted.org", "169.254.169.254"] });
  try {
    assert.equal(box.startup.source, "cold");
    assert.deepEqual(box.network, { allowHosts: ["pypi.org", "files.pythonhosted.org", "169.254.169.254"], secretHosts: [] });
    const ok = await fetchStatus(service, box.id, "https://pypi.org/simple/pip/");
    assert.equal(ok.stdout.trim(), "200", ok.stderr);
    assert.notEqual((await fetchStatus(service, box.id, "https://example.com/")).exitCode, 0, "example.com is not allowlisted");
    assert.notEqual((await fetchStatus(service, box.id, "http://169.254.169.254/latest/meta-data/")).exitCode, 0, "metadata is blocked even though allowlisted");
    assert.notEqual((await fetchStatus(service, box.id, "https://pypi.org:8443/")).exitCode, 0, "a port other than 80 and 443 is refused");
    const toControl = await service.exec(box.id, { cmd: ["python", "-c", "import os, socket, urllib.parse\nu = urllib.parse.urlparse(os.environ['HTTP_PROXY'])\nsocket.create_connection((u.hostname, 3129), timeout=3)"] });
    assert.notEqual(toControl.exitCode, 0, "the proxy's control port is not reachable from the sandbox");
    const pip = await service.exec(box.id, { cmd: ["pip", "download", "--no-deps", "-q", "-d", "/tmp/dl", "six"], timeoutMs: 120_000 });
    assert.equal(pip.exitCode, 0, pip.stderr);
    const toHost = await service.exec(box.id, { cmd: ["python", "-c", "import socket\nsocket.create_connection(('172.17.0.1', 7788), timeout=3)"] });
    assert.notEqual(toHost.exitCode, 0, "the docker bridge address of the host is not reachable");
    const log = await service.egressLog(box.id);
    assert.deepEqual(
      log.denied.map((d) => [d.method, d.host, d.reason]),
      [
        ["CONNECT", "example.com", "host not in allowHosts"],
        ["GET", "169.254.169.254", "resolves to a private address (169.254.169.254)"],
        ["CONNECT", "pypi.org", "port 8443 not allowed for pypi.org"],
      ],
    );
  } finally {
    await service.destroy(box.id);
  }
  const networks = await docker.listNetworks({ filters: { label: [LABEL_NETWORK] } });
  assert.equal(networks.some((n) => n.Name === `agentbox-${box.id}`), false, "the sandbox's network is removed with it");
});

test("K1: the proxy adds the secret for its host, and the secret is nowhere inside the sandbox", async () => {
  const secretConfig = loadConfig({ ...process.env, DEFAULT_TTL_SECONDS: "120", TEST_API_KEY: "hunter2-never-inside" });
  const withSecret = new SandboxService(new InMemorySandboxRepository(), templates, runtime, secretConfig, new SystemClock(), new RandomIdGenerator("sbxsec_"), new WarmPools());
  const box = await withSecret.create({ secrets: { "httpbin.org": "TEST_API_KEY" } });
  try {
    assert.deepEqual(box.network, { allowHosts: ["httpbin.org"], secretHosts: ["httpbin.org"] });
    const script = `import urllib.request
req = urllib.request.Request("https://httpbin.org/headers", headers={"Authorization": "Bearer from-inside"})
print(urllib.request.urlopen(req, timeout=20).read().decode())`;
    const r = await withSecret.exec(box.id, { cmd: ["python", "-c", script], timeoutMs: 30_000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /"Authorization": "Bearer hunter2-never-inside"/);
    assert.doesNotMatch(r.stdout, /from-inside/);
    const inside = await withSecret.exec(box.id, { cmd: ["sh", "-c", "env; cat /proc/1/environ; grep -rs hunter2 /workspace /tmp /etc /proc/self/environ; true"] });
    assert.doesNotMatch(inside.stdout, /hunter2/);
    assert.match(inside.stdout, /HTTPS_PROXY=http:\/\/sbxsec_/);
  } finally {
    await withSecret.destroy(box.id);
  }
});

test("S3: files in /workspace count as memory on top of memoryMb; past diskMb the write fails and the sandbox survives", async () => {
  const box = await service.create({ memoryMb: 256, diskMb: 512 });
  try {
    const fits = await service.exec(box.id, { cmd: ["sh", "-c", "head -c 400M /dev/zero > big && ls -l big | awk '{print $5}'"], timeoutMs: 60_000 });
    assert.equal(fits.exitCode, 0, fits.stderr);
    assert.equal(fits.stdout.trim(), String(400 * 1024 * 1024));
    const overflow = await service.exec(box.id, { cmd: ["sh", "-c", "head -c 200M /dev/zero > more"], timeoutMs: 60_000 });
    assert.notEqual(overflow.exitCode, 0);
    assert.match(overflow.stderr, /No space left/i);
    assert.equal((await service.exec(box.id, { cmd: ["echo", "alive"] })).stdout.trim(), "alive");
  } finally {
    await service.destroy(box.id);
  }
});

test("F2: cwd and env apply to one command only", async () => {
  await service.writeFile(id, "sub/dir/marker.txt", Buffer.from("here"));
  const r = await service.exec(id, { cmd: ["sh", "-c", "pwd; cat marker.txt; echo $GREETING"], cwd: "sub/dir", env: { GREETING: "hi" } });
  assert.equal(r.stdout, "/workspace/sub/dir\nherehi\n");
  const again = await service.exec(id, { cmd: ["sh", "-c", "pwd; echo [$GREETING]"] });
  assert.equal(again.stdout, "/workspace\n[]\n");
});

test("F7: a directory tree goes in as one archive, runs, and comes back out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-tree-"));
  const out = mkdtempSync(join(tmpdir(), "agentbox-tree-out-"));
  try {
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "__init__.py"), "VALUE = 41\n");
    writeFileSync(join(dir, "main.py"), "import pkg\nopen('result.txt', 'w').write(str(pkg.VALUE + 1))\n");
    const tar = execFileSync("tar", ["-c", "-C", dir, "."]);
    await service.putArchive(id, "proj", tar);
    const r = await service.exec(id, { cmd: ["python", "main.py"], cwd: "proj" });
    assert.equal(r.exitCode, 0, r.stderr);
    execFileSync("tar", ["-x", "-C", out], { input: await service.getArchive(id, "proj") });
    assert.equal(readFileSync(join(out, "result.txt"), "utf8"), "42");
    assert.equal(readFileSync(join(out, "pkg", "__init__.py"), "utf8"), "VALUE = 41\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("S3: an aborted exec is killed inside the sandbox, and the sandbox keeps working", async () => {
  const abort = new AbortController();
  const running = service.exec(id, { cmd: ["sh", "-c", "sleep 300; echo finished"], timeoutMs: 60_000 }, undefined, abort.signal);
  await new Promise((resolve) => setTimeout(resolve, 500));
  abort.abort();
  const r = await running;
  assert.equal(r.exitCode, 137);
  assert.ok(r.durationMs < 5_000, `took ${r.durationMs} ms`);
  // The kill runs detached, so give it a moment; count only processes whose command line is exactly "sleep 300".
  let left = "";
  for (let i = 0; i < 20; i++) {
    const check = await service.exec(id, { cmd: ["sh", "-c", "for p in /proc/[0-9]*; do [ \"$(tr '\\0' ' ' < $p/cmdline 2>/dev/null)\" = 'sleep 300 ' ] && echo $p; done; true"] });
    left = check.stdout.trim();
    if (left === "") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(left, "", `sleep processes still alive: ${left}`);
  assert.equal((await service.exec(id, { cmd: ["echo", "alive"] })).stdout.trim(), "alive");
});

test("restart: a second server run adopts running sandboxes from the SQLite file and reuses the proxy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-restart-"));
  const path = join(dir, "agentbox.db");
  const make = async (store: SqliteStore) => {
    const egress = new EgressProxyManager(docker, store.settings);
    const rt = new GvisorDockerRuntime(docker, config.runtime, config.image, config.maxOutputBytes, config.maxFileBytes, config.maxArchiveBytes, egress);
    await rt.init();
    return { rt, egress, svc: new SandboxService(store.sandboxes, templates, rt, config, new SystemClock(), new RandomIdGenerator("sbxrestart_"), new WarmPools()) };
  };
  const first = new SqliteStore(path);
  const run1 = await make(first);
  let plainId = "";
  let netId = "";
  try {
    plainId = (await run1.svc.create()).id;
    netId = (await run1.svc.create({ allowHosts: ["pypi.org"] })).id;
    await run1.svc.writeFile(plainId, "kept.txt", Buffer.from("still here"));
    first.close(); // the first server stops; containers and the proxy keep running

    const second = new SqliteStore(path);
    const run2 = await make(second);
    try {
      assert.equal(run2.egress.reused, true, "the proxy container from the first run is kept");
      const { adopted, lost } = await run2.svc.adopt();
      assert.deepEqual({ adopted: adopted.sort(), lost }, { adopted: [netId, plainId].sort(), lost: [] });
      assert.equal((await run2.svc.exec(plainId, { cmd: ["cat", "kept.txt"] })).stdout, "still here");
      const net = await fetchStatus(run2.svc, netId, "https://pypi.org/simple/pip/");
      assert.equal(net.stdout.trim(), "200", net.stderr);
    } finally {
      for (const s of run2.svc.list()) await run2.svc.destroy(s.id).catch(() => {});
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
