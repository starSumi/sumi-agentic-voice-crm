import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "../src/rate-limiter.ts";

test("rate limiting resets at the window boundary", () => {
  let clock = 1_000;
  const limiter = createRateLimiter({
    now: () => clock,
    windowMs: 1_000,
    maxRequests: 2,
    maxKeys: 10,
  });
  assert.equal(limiter.check("client-a").allowed, true);
  assert.equal(limiter.check("client-a").allowed, true);
  assert.equal(limiter.check("client-a").allowed, false);
  clock = 2_000;
  assert.equal(limiter.check("client-a").allowed, true);
});

test("rate limiting bounds key cardinality", () => {
  const limiter = createRateLimiter({
    windowMs: 1_000,
    maxRequests: 1,
    maxKeys: 2,
  });
  assert.equal(limiter.check("client-a").allowed, true);
  limiter.check("client-b");
  assert.equal(limiter.check("client-c").allowed, false);
  assert.equal(limiter.size, 2);
});
