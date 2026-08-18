import assert from "node:assert/strict";
import test from "node:test";
import { createGuardianReviewCoordinator } from "../src/control/index.ts";

test("Guardian review blocks rejected operations and interrupts repeated denials", async () => {
  const coordinator = createGuardianReviewCoordinator({
    evaluate: async () => ({ decision: "reject" }),
  });
  assert.equal((await coordinator.review({ turn_id: "turn-1" })).kind, "reject");
  assert.equal((await coordinator.review({ turn_id: "turn-1" })).kind, "reject");
  const interrupted = await coordinator.review({ turn_id: "turn-1" });
  assert.equal(interrupted.kind, "interrupt_turn");
  assert.equal(interrupted.action.newly_triggered, true);
});

test("Guardian allow resets consecutive denials without overriding an interrupted turn", async () => {
  const decisions = ["reject", "allow", "reject"];
  const coordinator = createGuardianReviewCoordinator({
    evaluate: async () => ({ decision: decisions.shift() }),
  });
  assert.equal((await coordinator.review({ turn_id: "turn-reset" })).action.consecutive_denials, 1);
  assert.equal((await coordinator.review({ turn_id: "turn-reset" })).kind, "allow");
  assert.equal((await coordinator.review({ turn_id: "turn-reset" })).action.consecutive_denials, 1);
});

test("Guardian malformed output and unavailability fail closed to human review", async () => {
  const malformed = createGuardianReviewCoordinator({ evaluate: async () => ({ decision: "maybe" }) });
  assert.deepEqual(await malformed.review({ turn_id: "turn-malformed" }), {
    kind: "human_review_required",
    reason: "guardian_malformed",
  });
  const unavailable = createGuardianReviewCoordinator({ evaluate: async () => { throw new Error("offline"); } });
  assert.deepEqual(await unavailable.review({ turn_id: "turn-unavailable" }), {
    kind: "human_review_required",
    reason: "guardian_unavailable",
  });
});

test("Guardian timeout requests supervised termination and caller cancellation propagates", async () => {
  const terminations = [];
  const timed = createGuardianReviewCoordinator({
    evaluate: async () => await new Promise(() => {}),
    reviewTimeoutMs: 5,
    hardGraceMs: 5,
    terminate: () => terminations.push("terminated"),
  });
  assert.deepEqual(await timed.review({ turn_id: "turn-timeout" }), {
    kind: "human_review_required",
    reason: "guardian_timeout",
  });
  assert.deepEqual(terminations, ["terminated"]);

  const parent = new AbortController();
  const cancelled = createGuardianReviewCoordinator({
    evaluate: async ({ signal }) => await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    reviewTimeoutMs: 100,
    hardGraceMs: 5,
  });
  const pending = cancelled.review({ turn_id: "turn-cancelled", signal: parent.signal });
  parent.abort(Object.assign(new Error("caller stopped"), { name: "AbortError" }));
  await assert.rejects(pending, /caller stopped/);
});
