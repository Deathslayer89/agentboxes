import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateSubnets, isAlreadyConnected } from "../../../src/runtime/egressProxy.js";

test("an already-connected network error is recognised by its Docker message, so re-attaching is a no-op", () => {
  assert.equal(isAlreadyConnected({ message: "endpoint with name agentbox-sbx_1 already exists in network agentbox-sbx_1" }), true);
  assert.equal(isAlreadyConnected({ message: "container is already connected to network foo" }), true);
  assert.equal(isAlreadyConnected({ statusCode: 403, message: "forbidden" }), false);
  assert.equal(isAlreadyConnected(new Error("boom")), false);
  assert.equal(isAlreadyConnected(undefined), false);
});

test("candidateSubnets walks the pool's /24s in order and skips ones already on the host", () => {
  const used = new Set(["10.201.0.0/24", "10.201.1.0/24"]);
  const gen = candidateSubnets("10.201", used);
  assert.equal(gen.next().value, "10.201.2.0/24", "the first two /24s are taken, so it starts at the third");
  assert.equal(gen.next().value, "10.201.3.0/24");
  const all = [...candidateSubnets("10.201", new Set())];
  assert.equal(all.length, 256, "a /16 yields 256 candidate /24s");
  assert.equal(all[0], "10.201.0.0/24");
  assert.equal(all[255], "10.201.255.0/24");
  assert.equal([...candidateSubnets("10.42", new Set())][5], "10.42.5.0/24", "the pool prefix is respected");
});
