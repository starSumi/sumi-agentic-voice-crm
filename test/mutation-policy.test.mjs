import test from "node:test";
import assert from "node:assert/strict";
import { isMutatingIntent, normalizeUnderstanding, requiresReview } from "../src/mutation-policy.mjs";

const understanding = (intent, needs_confirmation) => ({
  intent,
  confidence: 0.99,
  entities: {},
  missing: [],
  needs_confirmation,
  });
test("mutating intents always require review regardless of provider flag", () => {
  assert.equal(isMutatingIntent("crm.deal.update_stage"), true);
  assert.equal(isMutatingIntent("crm.customer.create"), true);
  assert.equal(requiresReview(understanding("crm.deal.update_stage", false)), true);
  assert.equal(normalizeUnderstanding(understanding("crm.customer.create", false)).needs_confirmation, true);
});

test("read-only intents continue to honor provider confirmation", () => {
  assert.equal(isMutatingIntent("crm.search"), false);
  assert.equal(normalizeUnderstanding(understanding("crm.search", false)).needs_confirmation, false);
  assert.equal(normalizeUnderstanding(understanding("crm.search", true)).needs_confirmation, true);
});

test("unknown intents fail closed as mutating", () => {
  assert.equal(isMutatingIntent("crm.future_command"), true);
  assert.equal(normalizeUnderstanding(understanding("crm.future_command", false)).needs_confirmation, true);
});
