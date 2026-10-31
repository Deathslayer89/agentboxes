import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "./errors.js";
import { parseCreateRequest, parseExecRequest } from "./http/validation.js";

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
