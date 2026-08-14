import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationsSnapshot } from "../scripts/agent-ops.mjs";

test("CI snapshot records the trusted branch when checkout is detached", async () => {
  const snapshot = await createOperationsSnapshot({
    now: new Date("2026-08-15T00:00:00Z"),
    environment: {
      SUMI_OPS_BRANCH: "trusted-main",
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_RUN_ID: "31811267636",
    },
    sessionId: "github-actions-31811267636",
  });

  assert.equal(snapshot.source.branch, "trusted-main");
  assert.equal(snapshot.session.id, "github-actions-31811267636");
});
