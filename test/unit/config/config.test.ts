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
  assert.equal(loadConfig({ AGENTBOX_RUNTIME: "firecracker" }).runtime, "firecracker");
  assert.throws(() => loadConfig({ AGENTBOX_RUNTIME: "runc" }), /runsc/);
});

test("API keys: the single key is named default; the list adds named keys with optional limits", () => {
  assert.deepEqual(loadConfig({}).apiKeys, []);
  assert.deepEqual(loadConfig({ AGENTBOX_API_KEY: "abc" }).apiKeys, [{ name: "default", key: "abc" }]);
  assert.deepEqual(loadConfig({ AGENTBOX_API_KEY: "abc", AGENTBOX_API_KEYS: "team-a:k1:2:1024, bot:k2" }).apiKeys, [
    { name: "default", key: "abc" },
    { name: "team-a", key: "k1", maxSandboxes: 2, maxMemoryMb: 1024 },
    { name: "bot", key: "k2" },
  ]);
  for (const bad of ["nokey", "Bad Name:k", "a:k:x", "a:k:0", "a:k1,a:k2"]) {
    assert.throws(() => loadConfig({ AGENTBOX_API_KEYS: bad }), bad);
  }
});

test("AGENTBOX_SECRETS binds each secret to one host and resolves its value from the environment", () => {
  assert.deepEqual(loadConfig({}).secrets, {});
  const secrets = loadConfig({
    OPENAI_API_KEY: "sk-openai",
    ANTHROPIC_API_KEY: "sk-anthropic",
    AGENTBOX_SECRETS: '{"API.openai.com":"OPENAI_API_KEY","api.anthropic.com":{"env":"ANTHROPIC_API_KEY","header":"x-api-key"}}',
  }).secrets;
  assert.deepEqual(secrets, {
    "api.openai.com": { header: "Authorization", value: "Bearer sk-openai" },
    "api.anthropic.com": { header: "x-api-key", value: "sk-anthropic" },
  });
});

test("AGENTBOX_SECRETS is refused when its JSON, its variable or its header is wrong", () => {
  assert.throws(() => loadConfig({ AGENTBOX_SECRETS: "not json" }), /must be JSON/);
  assert.throws(() => loadConfig({ AGENTBOX_SECRETS: '["api.openai.com"]' }), /object of host to secret/);
  assert.throws(() => loadConfig({ AGENTBOX_SECRETS: '{"api.openai.com":"MISSING_KEY"}' }), /MISSING_KEY for api.openai.com is not set/);
  assert.throws(() => loadConfig({ KEY: "v", AGENTBOX_SECRETS: '{"api.openai.com":{"env":"KEY","header":"Host"}}' }), /may not use the Host header/);
});
