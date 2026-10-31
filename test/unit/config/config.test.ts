import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, parsePoolSizes } from "../../../src/config.js";

test("POOL_SIZES parses name:count pairs and defaults to one default pool of 3", () => {
  assert.deepEqual(parsePoolSizes(undefined), { default: 3 });
  assert.deepEqual(parsePoolSizes("default:0"), { default: 0 });
  assert.deepEqual(parsePoolSizes("default:3, data-science:2"), { default: 3, "data-science": 2 });
  for (const bad of ["default", "default:x", "Bad Name:1", "default:-1", ":1"]) {
    assert.throws(() => parsePoolSizes(bad), /POOL_SIZES/, bad);
  }
});

test("a default above its maximum is refused at boot", () => {
  assert.throws(() => loadConfig({ DEFAULT_MEMORY_MB: "8192" }), /above its maximum/);
  assert.throws(() => loadConfig({ MAX_SANDBOXES: "0" }), /positive/);
});

test("the server stays on loopback unless HOST is set, and a non-loopback HOST needs an API key", () => {
  assert.equal(loadConfig({}).host, "127.0.0.1");
  assert.equal(loadConfig({ AGENTBOX_API_KEY: "k" }).host, "127.0.0.1");
  assert.equal(loadConfig({ AGENTBOX_API_KEY: "k", HOST: "0.0.0.0" }).host, "0.0.0.0");
  assert.throws(() => loadConfig({ HOST: "0.0.0.0" }), /AGENTBOX_API_KEY/);
});

test("AGENTBOX_RUNTIME accepts runsc variants only, and defaults to auto", () => {
  assert.equal(loadConfig({}).runtime, "auto");
  assert.equal(loadConfig({ AGENTBOX_RUNTIME: "runsc" }).runtime, "runsc");
  assert.equal(loadConfig({ AGENTBOX_RUNTIME: "runsc-kvm" }).runtime, "runsc-kvm");
  assert.throws(() => loadConfig({ AGENTBOX_RUNTIME: "runc" }), /runsc/);
});
