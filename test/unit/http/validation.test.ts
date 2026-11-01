import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "../../../src/errors.js";
import { parseCreateRequest, parseExecRequest } from "../../../src/http/validation.js";

test("create request: empty body means defaults, known numeric fields are kept", () => {
  assert.deepEqual(parseCreateRequest(undefined), {});
  assert.deepEqual(parseCreateRequest({}), {});
  assert.deepEqual(parseCreateRequest({ memoryMb: 256, cpus: 0.5, unknown: 1 }), { memoryMb: 256, cpus: 0.5 });
});

test("create request: rejects non-objects, non-numbers, zero, negatives and fractions where integers are needed", () => {
  assert.throws(() => parseCreateRequest([]), ValidationError);
  assert.throws(() => parseCreateRequest({ memoryMb: "512" }), ValidationError);
  assert.throws(() => parseCreateRequest({ memoryMb: 0 }), ValidationError);
  assert.throws(() => parseCreateRequest({ ttlSeconds: -1 }), ValidationError);
  assert.throws(() => parseCreateRequest({ pids: 1.5 }), ValidationError);
});

test("create request: template must be a well-formed name", () => {
  assert.deepEqual(parseCreateRequest({ template: "data-science" }), { template: "data-science" });
  assert.throws(() => parseCreateRequest({ template: "Data Science" }), ValidationError);
  assert.throws(() => parseCreateRequest({ template: "../x" }), ValidationError);
  assert.throws(() => parseCreateRequest({ template: 1 }), ValidationError);
});

test("exec request: cmd must be a non-empty string array, timeoutMs optional", () => {
  assert.deepEqual(parseExecRequest({ cmd: ["python", "-c", "print(1)"] }), { cmd: ["python", "-c", "print(1)"] });
  assert.deepEqual(parseExecRequest({ cmd: ["true"], timeoutMs: 500 }), { cmd: ["true"], timeoutMs: 500 });
  assert.throws(() => parseExecRequest({}), ValidationError);
  assert.throws(() => parseExecRequest({ cmd: [] }), ValidationError);
  assert.throws(() => parseExecRequest({ cmd: "python" }), ValidationError);
  assert.throws(() => parseExecRequest({ cmd: ["python", 1] }), ValidationError);
  assert.throws(() => parseExecRequest({ cmd: ["true"], timeoutMs: 0 }), ValidationError);
});

test("create request: allowHosts and secrets are checked and lowercased", () => {
  assert.deepEqual(
    parseCreateRequest({ allowHosts: ["PyPI.org", "*.example.com", "10.0.0.1", "DB.example.com:5432", "10.0.0.2:8080", "::1"] }),
    { allowHosts: ["pypi.org", "*.example.com", "10.0.0.1", "db.example.com:5432", "10.0.0.2:8080", "::1"] },
  );
  assert.deepEqual(parseCreateRequest({ secrets: { "API.openai.com": "OPENAI_API_KEY" } }), { secrets: { "api.openai.com": "OPENAI_API_KEY" } });
  const spec = { env: "ANTHROPIC_API_KEY", header: "x-api-key", prefix: "" };
  assert.deepEqual(parseCreateRequest({ secrets: { "api.anthropic.com": spec } }), { secrets: { "api.anthropic.com": spec } });
  for (const bad of [{ allowHosts: "pypi.org" }, { allowHosts: ["not a host"] }, { allowHosts: ["http://pypi.org"] }, { allowHosts: [1] }, { allowHosts: ["pypi.org:0"] }, { allowHosts: ["pypi.org:70000"] }, { allowHosts: ["[::1]:443"] }]) {
    assert.throws(() => parseCreateRequest(bad), ValidationError, JSON.stringify(bad));
  }
  const badSpecs = [{ header: "x-api-key" }, { env: "lower" }, { env: "KEY", header: "Host" }, { env: "KEY", header: "not a header" }, { env: "KEY", prefix: "a\r\nb" }, { env: "KEY", prefix: "x".repeat(65) }];
  for (const bad of [{ secrets: [] }, { secrets: { "*.openai.com": "KEY" } }, { secrets: { "api.openai.com": "lowercase" } }, { secrets: { "api.openai.com": 1 } }, ...badSpecs.map((s) => ({ secrets: { "api.openai.com": s } }))]) {
    assert.throws(() => parseCreateRequest(bad), ValidationError, JSON.stringify(bad));
  }
});

test("exec request: cwd and env are optional and checked", () => {
  assert.deepEqual(parseExecRequest({ cmd: ["ls"], cwd: "src", env: { CI: "1" } }), { cmd: ["ls"], cwd: "src", env: { CI: "1" } });
  assert.throws(() => parseExecRequest({ cmd: ["ls"], cwd: "" }), ValidationError);
  assert.throws(() => parseExecRequest({ cmd: ["ls"], env: { "BAD NAME": "1" } }), ValidationError);
  assert.throws(() => parseExecRequest({ cmd: ["ls"], env: { CI: 1 } }), ValidationError);
  assert.throws(() => parseExecRequest({ cmd: ["ls"], env: ["CI=1"] }), ValidationError);
});
