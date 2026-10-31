import assert from "node:assert/strict";
import test from "node:test";
import { Metrics } from "../../../src/services/metrics.js";

test("renders gauges, counters and the exec histogram in the Prometheus text format", () => {
  const m = new Metrics();
  m.creates.pool = 3;
  m.removals.expired = 1;
  m.observeExec(0.03);
  m.observeExec(0.3);
  const text = m.render(2, { default: { size: 3, ready: 2, starting: 1, hits: 3, misses: 0 } });
  for (const line of [
    "# TYPE agentbox_sandboxes_live gauge",
    "agentbox_sandboxes_live 2",
    'agentbox_pool_ready{template="default"} 2',
    'agentbox_pool_hits_total{template="default"} 3',
    'agentbox_creates_total{source="pool"} 3',
    'agentbox_creates_total{source="cold"} 0',
    'agentbox_removals_total{reason="expired"} 1',
    'agentbox_exec_duration_seconds_bucket{le="0.025"} 0',
    'agentbox_exec_duration_seconds_bucket{le="0.05"} 1',
    'agentbox_exec_duration_seconds_bucket{le="0.5"} 2',
    'agentbox_exec_duration_seconds_bucket{le="+Inf"} 2',
    "agentbox_exec_duration_seconds_count 2",
  ]) {
    assert.ok(text.includes(line + "\n"), `missing: ${line}`);
  }
  assert.match(text, /agentbox_exec_duration_seconds_sum 0\.3(3|2999)/);
});
