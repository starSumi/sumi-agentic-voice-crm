import assert from "node:assert/strict";
import test from "node:test";
import { containsRepositoryCodeExecution } from "../scripts/workflow-safety.mjs";

test("protected workflow jobs reject package managers and repository execution", () => {
  for (const command of [
    "- uses: actions/checkout@0123456789abcdef",
    "- run: npm audit",
    "- run: pnpm run verify",
    "- run: pnpm exec node scripts/check.mjs",
    "- run: node scripts/check-agent.mjs",
  ]) {
    assert.equal(containsRepositoryCodeExecution(command), true, command);
  }
});

test("protected workflow jobs allow API-only reconciliation commands", () => {
  assert.equal(containsRepositoryCodeExecution("- run: gh api repos/$REPO/actions/runs"), false);
  assert.equal(containsRepositoryCodeExecution("- run: jq -r .conclusion event.json"), false);
});
