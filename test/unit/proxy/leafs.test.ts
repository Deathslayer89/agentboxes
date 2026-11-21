import assert from "node:assert/strict";
import test from "node:test";
import { LeafCache } from "../../../proxy/leafs.mjs";

test("a cached leaf is reused until the renew point, then reissued", async () => {
  let issued = 0;
  let clock = 0;
  const cache = new LeafCache(async () => ({ key: "k", cert: `cert${issued++}` }), 1000, () => clock);
  assert.equal((await cache.get(null, "example.com")).cert, "cert0");
  clock = 999; // still inside the renew window
  assert.equal((await cache.get(null, "example.com")).cert, "cert0", "reused before the renew point");
  clock = 1000; // at the renew point
  assert.equal((await cache.get(null, "example.com")).cert, "cert1", "reissued once old enough");
  assert.equal(issued, 2);
});

test("a failed issue is dropped from the cache so the next request retries instead of the same rejection", async () => {
  let attempt = 0;
  const cache = new LeafCache(
    async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return { key: "k", cert: "ok" };
    },
    1000,
    () => 0,
  );
  await assert.rejects(cache.get(null, "h"), /boom/);
  assert.equal((await cache.get(null, "h")).cert, "ok", "the retry issues a fresh leaf, not the cached rejection");
  assert.equal(attempt, 2);
});

test("clear drops cached leaves so none signed by an old CA is served", async () => {
  let issued = 0;
  const cache = new LeafCache(async () => ({ key: "k", cert: `cert${issued++}` }), 1000, () => 0);
  assert.equal((await cache.get(null, "h")).cert, "cert0");
  cache.clear();
  assert.equal((await cache.get(null, "h")).cert, "cert1", "a fresh leaf is issued after clear");
});
