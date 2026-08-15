import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOperationsSnapshot,
  inspectControlPlane,
  runCli,
} from "../scripts/agent-ops.mjs";
import { reconcileCiIncident } from "../scripts/agent-incident.mjs";

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    },
  };
}

test("control-plane inspection verifies the reviewed cursor and maintainers", async () => {
  const inspection = await inspectControlPlane({
    now: new Date("2026-08-15T00:00:00Z"),
    includeFreshness: true,
  });
  assert.equal(inspection.manifest.current_phase, "P4-crm-safety-and-persistence");
  assert.equal(inspection.manifest.current_checkpoint, "C2");
  assert.equal(inspection.healthIssues.length, 0);
  assert.equal(inspection.manifest.active_roles.length, 27);
});

test("operations snapshot keeps runtime agent edges separate from the versioned cursor", async () => {
  const snapshot = await createOperationsSnapshot({
    now: new Date("2026-08-15T00:00:00Z"),
    environment: {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      SUMI_OPS_CONCLUSION: "success",
      SUMI_OPS_RUN_URL:
        "https://github.com/starSumi/sumi-agentic-voice-crm/actions/runs/1",
    },
    sessionId: "thread-test",
    agents: [{ id: "/root/worker", state: "open" }],
  });
  assert.equal(snapshot.session.id, "thread-test");
  assert.deepEqual(snapshot.session.agent_edges, [
    { id: "/root/worker", state: "open" },
  ]);
  assert.equal(snapshot.maintenance.status, "current");
  assert.equal(snapshot.release.human_acceptance_required, true);
});

test("resume rejects a session id that could escape the external state root", async () => {
  await assert.rejects(
    runCli(["resume", "--session-id", "../outside"], {
      LOCALAPPDATA: "C:\\ignored-in-test",
    }),
    /session id must be a stable identifier/,
  );
});

test("incident reconciliation creates one issue for a failed trusted run", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("issues?state=open")) return response(200, []);
    return response(201, { number: 7 });
  };
  const result = await reconcileCiIncident({
    fetchImpl,
    token: "test-token",
    repository: "starSumi/sumi-agentic-voice-crm",
    conclusion: "failure",
    runUrl:
      "https://github.com/starSumi/sumi-agentic-voice-crm/actions/runs/123",
    headSha: "a".repeat(40),
    reason: "health=failure",
    eventName: "schedule",
    now: new Date("2026-08-15T00:00:00Z"),
  });
  assert.deepEqual(result, { action: "created", count: 1, issueNumber: 7 });
  const created = JSON.parse(calls[1].options.body);
  assert.equal(created.title, "[CI Operations] main requires attention");
  assert.match(created.body, /does not edit source/);
});

test("incident reconciliation closes an existing issue after recovery", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("issues?state=open")) {
      return response(200, [
        { number: 9, title: "[CI Operations] main requires attention" },
      ]);
    }
    return response(200, {});
  };
  const result = await reconcileCiIncident({
    fetchImpl,
    token: "test-token",
    repository: "starSumi/sumi-agentic-voice-crm",
    conclusion: "success",
    runUrl:
      "https://github.com/starSumi/sumi-agentic-voice-crm/actions/runs/124",
    headSha: "b".repeat(40),
    reason: "all gates passed",
    eventName: "workflow_run",
    now: new Date("2026-08-15T00:00:00Z"),
  });
  assert.deepEqual(result, { action: "closed", count: 1 });
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[2].options.body).state, "closed");
});
