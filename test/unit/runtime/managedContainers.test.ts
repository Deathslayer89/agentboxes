import assert from "node:assert/strict";
import test from "node:test";
import type Docker from "dockerode";
import type { EgressProxyManager } from "../../../src/runtime/egressProxy.js";
import { GvisorDockerRuntime } from "../../../src/runtime/gvisorDockerRuntime.js";

type Container = { Id: string; Labels: Record<string, string>; State: string };

// A Docker stand-in that applies label filters the way the real daemon does, over a fixed set of containers.
function fakeDocker(containers: Container[]): Docker {
  return {
    listContainers: async (opts: { filters?: { label?: string[] } }) => {
      const labels = opts.filters?.label ?? [];
      return containers.filter((c) =>
        labels.every((rule) => {
          const eq = rule.indexOf("=");
          if (eq === -1) return rule in c.Labels;
          return c.Labels[rule.slice(0, eq)] === rule.slice(eq + 1);
        }),
      );
    },
  } as unknown as Docker;
}

function runtimeFor(serverId: string, docker: Docker): GvisorDockerRuntime {
  return new GvisorDockerRuntime(docker, "runsc", "img", 1, 1, 1, undefined as unknown as EgressProxyManager, serverId);
}

test("listManaged returns the containers this server created and not another server's", async () => {
  const docker = fakeDocker([
    { Id: "a", Labels: { agentbox: "1", "agentbox.id": "sbxA", "agentbox.server": "srvA" }, State: "running" },
    { Id: "b", Labels: { agentbox: "1", "agentbox.id": "sbxB", "agentbox.server": "srvB" }, State: "running" },
    { Id: "legacy", Labels: { agentbox: "1", "agentbox.id": "sbxOld" }, State: "exited" },
  ]);
  const mine = await runtimeFor("srvA", docker).listManaged();
  assert.deepEqual(
    mine.map((c) => c.handle),
    ["a"],
    "another server's container (b) and an unlabelled one (legacy) must not appear, or the reaper would destroy them as orphans",
  );
});
