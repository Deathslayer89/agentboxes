import assert from "node:assert/strict";
import { test } from "node:test";
import { isAlreadyConnected } from "../../../src/runtime/egressProxy.js";

test("an already-connected network error is recognised by its Docker message, so re-attaching is a no-op", () => {
  assert.equal(isAlreadyConnected({ message: "endpoint with name agentbox-sbx_1 already exists in network agentbox-sbx_1" }), true);
  assert.equal(isAlreadyConnected({ message: "container is already connected to network foo" }), true);
  assert.equal(isAlreadyConnected({ statusCode: 403, message: "forbidden" }), false);
  assert.equal(isAlreadyConnected(new Error("boom")), false);
  assert.equal(isAlreadyConnected(undefined), false);
});
