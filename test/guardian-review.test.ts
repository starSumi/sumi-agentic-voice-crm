import assert from "node:assert/strict";
import test from "node:test";
import { createGuardianReviewCoordinator } from "../src/control/index.ts";

type ReviewOptions = NonNullable<
  Parameters<typeof createGuardianReviewCoordinator>[0]
>;
type GuardianEvaluate = NonNullable<ReviewOptions["evaluate"]>;

function actionOf(
  review: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const action = review.action;
  assert.ok(action && typeof action === "object" && !Array.isArray(action));
  return action as Readonly<Record<string, unknown>>;
}

function uncheckedEvaluate(decision: unknown): GuardianEvaluate {
  return (async () => decision) as unknown as GuardianEvaluate;
}

test("Guardian review blocks rejected operations and interrupts repeated denials", async () => {
  const coordinator = createGuardianReviewCoordinator({
    evaluate: async () => ({ decision: "reject" }),
  });
  assert.equal(
    (await coordinator.review({ turn_id: "turn-1" })).kind,
    "reject",
  );
  assert.equal(
    (await coordinator.review({ turn_id: "turn-1" })).kind,
    "reject",
  );
  const interrupted = await coordinator.review({ turn_id: "turn-1" });
  assert.equal(interrupted.kind, "interrupt_turn");
  assert.equal(actionOf(interrupted).newly_triggered, true);
});

test("Guardian allow resets consecutive denials without overriding an interrupted turn", async () => {
  const decisions: Array<"allow" | "reject"> = ["reject", "allow", "reject"];
  const coordinator = createGuardianReviewCoordinator({
    evaluate: async () => {
      const decision = decisions.shift();
      assert.ok(decision);
      return { decision };
    },
  });
  const first = await coordinator.review({ turn_id: "turn-reset" });
  assert.equal(actionOf(first).consecutive_denials, 1);
  assert.equal(
    (await coordinator.review({ turn_id: "turn-reset" })).kind,
    "allow",
  );
  const third = await coordinator.review({ turn_id: "turn-reset" });
  assert.equal(actionOf(third).consecutive_denials, 1);
});

test("Guardian malformed output and unavailability fail closed to human review", async () => {
  const malformed = createGuardianReviewCoordinator({
    evaluate: uncheckedEvaluate({ decision: "maybe" }),
  });
  assert.deepEqual(await malformed.review({ turn_id: "turn-malformed" }), {
    kind: "human_review_required",
    reason: "guardian_malformed",
  });
  const unavailable = createGuardianReviewCoordinator({
    evaluate: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(await unavailable.review({ turn_id: "turn-unavailable" }), {
    kind: "human_review_required",
    reason: "guardian_unavailable",
  });
});

test("Guardian timeout requests supervised termination and caller cancellation propagates", async () => {
  const terminations: string[] = [];
  const timed = createGuardianReviewCoordinator({
    evaluate: async () => await new Promise<never>(() => {}),
    reviewTimeoutMs: 5,
    hardGraceMs: 5,
    terminate: () => {
      terminations.push("terminated");
    },
  });
  assert.deepEqual(await timed.review({ turn_id: "turn-timeout" }), {
    kind: "human_review_required",
    reason: "guardian_timeout",
  });
  assert.deepEqual(terminations, ["terminated"]);

  const parent = new AbortController();
  const cancelled = createGuardianReviewCoordinator({
    evaluate: async ({ signal }) =>
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
    reviewTimeoutMs: 100,
    hardGraceMs: 5,
  });
  const pending = cancelled.review({
    turn_id: "turn-cancelled",
    signal: parent.signal,
  });
  parent.abort(
    Object.assign(new Error("caller stopped"), { name: "AbortError" }),
  );
  await assert.rejects(pending, /caller stopped/);
});
