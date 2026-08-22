import assert from "node:assert/strict";
import test from "node:test";
import { checkTransportPolicy } from "../scripts/check-transport-policy.mjs";

test("transport spec matches the executable API selection policy", async () => {
  const policy = await checkTransportPolicy();
  assert.equal(policy.core, "single-application-core");
  assert.equal(policy.projection_bus.pattern, "spmc");
  assert.deepEqual(policy.lifecycle_hooks, ["start", "ready", "drain", "close"]);
});
