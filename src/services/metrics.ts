import type { PoolStats } from "./warmPool.js";

// Upper bounds, in seconds, of the exec latency histogram.
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

// Counters the service bumps as it works, rendered in the Prometheus text format.
export class Metrics {
  readonly creates = { pool: 0, cold: 0 };
  readonly removals = { destroyed: 0, expired: 0 };
  private readonly execBuckets = BUCKETS.map(() => 0);
  private execCount = 0;
  private execSeconds = 0;

  observeExec(seconds: number): void {
    this.execCount += 1;
    this.execSeconds += seconds;
    BUCKETS.forEach((bound, i) => {
      if (seconds <= bound) this.execBuckets[i] = (this.execBuckets[i] ?? 0) + 1;
    });
  }

  render(live: number, pools: Record<string, PoolStats>): string {
    const lines: string[] = [];
    const metric = (name: string, help: string, type: string, samples: Array<[string, number]>) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
    };
    metric("agentbox_sandboxes_live", "Sandboxes that are starting, ready or busy.", "gauge", [["", live]]);
    const perPool = (pick: (s: PoolStats) => number) => Object.entries(pools).map(([t, s]): [string, number] => [`{template="${t}"}`, pick(s)]);
    metric("agentbox_pool_size", "Containers each pool keeps ready.", "gauge", perPool((s) => s.size));
    metric("agentbox_pool_ready", "Containers ready to claim.", "gauge", perPool((s) => s.ready));
    metric("agentbox_pool_hits_total", "Creates served from the pool.", "counter", perPool((s) => s.hits));
    metric("agentbox_pool_misses_total", "Creates that found the pool empty.", "counter", perPool((s) => s.misses));
    metric("agentbox_creates_total", "Sandboxes created, by where the container came from.", "counter", [
      ['{source="pool"}', this.creates.pool],
      ['{source="cold"}', this.creates.cold],
    ]);
    metric("agentbox_removals_total", "Sandboxes removed, by the caller or by the TTL reaper.", "counter", [
      ['{reason="destroyed"}', this.removals.destroyed],
      ['{reason="expired"}', this.removals.expired],
    ]);
    const histogram: Array<[string, number]> = BUCKETS.map((bound, i) => [`_bucket{le="${bound}"}`, this.execBuckets[i] ?? 0]);
    histogram.push(['_bucket{le="+Inf"}', this.execCount], ["_sum", this.execSeconds], ["_count", this.execCount]);
    lines.push("# HELP agentbox_exec_duration_seconds Time from exec request to result, as the server sees it.", "# TYPE agentbox_exec_duration_seconds histogram");
    for (const [suffix, value] of histogram) lines.push(`agentbox_exec_duration_seconds${suffix} ${value}`);
    return lines.join("\n") + "\n";
  }
}
