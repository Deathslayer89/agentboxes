import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadOrCreateProxyCa } from "../../../src/runtime/proxyCa.js";

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

test("the proxy CA is generated once, stored with a 0600 key, and reloaded unchanged", { skip: !hasOpenssl }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-ca-"));
  try {
    const first = await loadOrCreateProxyCa(dir);
    assert.match(first.cert, /BEGIN CERTIFICATE/);
    assert.match(first.key, /BEGIN (EC )?PRIVATE KEY/);
    assert.equal(statSync(join(dir, "ca.key")).mode & 0o777, 0o600, "the private key file is not world- or group-readable");
    const second = await loadOrCreateProxyCa(dir);
    assert.equal(second.cert, first.cert, "a reload returns the stored CA, not a fresh one");
    assert.equal(second.key, first.key);
  } finally {
    rmSync(dir, { recursive: true, force: true }); // the CA key must not be left behind in the temp dir
  }
});
