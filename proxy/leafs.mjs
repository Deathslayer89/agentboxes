/**
 * Per-host leaf certificates issued from the proxy's CA. Concurrent requests for the same host share one issue in
 * flight; a cached leaf is reused until it is near expiry and then reissued, so a long-running proxy never serves an
 * expired cert; and a failed issue is dropped from the cache so the next request retries instead of getting the same
 * rejection forever.
 */
export class LeafCache {
  /**
   * @param {(authority: unknown, target: string) => Promise<{ key: string, cert: string }>} issue
   * @param {number} renewMs reissue once a cached leaf is this old
   * @param {() => number} now current time in ms, injectable for tests
   */
  constructor(issue, renewMs, now = Date.now) {
    this.issue = issue;
    this.renewMs = renewMs;
    this.now = now;
    // target -> { pending, issuedAt }
    this.leafs = new Map();
  }

  // Drops every cached leaf, so after the CA changes none signed by the old one is served.
  clear() {
    this.leafs.clear();
  }

  get(authority, target) {
    const entry = this.leafs.get(target);
    if (entry !== undefined && this.now() - entry.issuedAt < this.renewMs) return entry.pending;
    const pending = this.issue(authority, target).catch((err) => {
      if (this.leafs.get(target)?.pending === pending) this.leafs.delete(target);
      throw err;
    });
    this.leafs.set(target, { pending, issuedAt: this.now() });
    return pending;
  }
}
