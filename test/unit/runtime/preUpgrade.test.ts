import assert from "node:assert/strict";
import { test } from "node:test";
import { isPreUpgradeSandbox } from "../../../src/runtime/gvisorDockerRuntime.js";

test("a container is pre-upgrade when it has the agentbox label but no per-server label", () => {
  assert.equal(isPreUpgradeSandbox({ agentbox: "1" }), true);
  assert.equal(isPreUpgradeSandbox({ agentbox: "1", "agentbox.server": "srv1" }), false);
  assert.equal(isPreUpgradeSandbox({ "agentbox.server": "srv1" }), false);
  assert.equal(isPreUpgradeSandbox({}), false);
});
