import assert from "node:assert/strict";
import test from "node:test";
import { createGuardianDenialGovernor } from "../src/control/index.ts";

test("standard Guardian policy interrupts after three consecutive denials", () => {
  const governor = createGuardianDenialGovernor();
  assert.equal(governor.recordDenial("turn-1").kind, "continue");
  assert.equal(governor.recordDenial("turn-1").kind, "continue");
  assert.deepEqual(governor.recordDenial("turn-1"), {
    kind: "interrupt_turn",
    policy: "standard",
    consecutive_denials: 3,
    recent_denials: 3,
    newly_triggered: true,
  });
  assert.equal(governor.recordDenial("turn-1").newly_triggered, false);
  assert.equal(governor.recordNonDenial("turn-1").kind, "interrupt_turn");
  assert.equal(governor.snapshot("turn-1").consecutive_denials, 0);
});

test("non-denial resets consecutive count while the recent window remains bounded", () => {
  const governor = createGuardianDenialGovernor();
  governor.recordDenial("turn-reset");
  governor.recordNonDenial("turn-reset");
  assert.equal(governor.recordDenial("turn-reset").consecutive_denials, 1);
  for (let index = 0; index < 60; index += 1) governor.recordNonDenial("turn-reset");
  assert.equal(governor.snapshot("turn-reset").review_count, 50);
});

test("standard Guardian policy interrupts at ten non-consecutive denials in the recent window", () => {
  const governor = createGuardianDenialGovernor();
  for (let index = 0; index < 9; index += 1) {
    assert.equal(governor.recordDenial("turn-window").kind, "continue");
    governor.recordNonDenial("turn-window");
  }
  const action = governor.recordDenial("turn-window");
  assert.equal(action.kind, "interrupt_turn");
  assert.equal(action.consecutive_denials, 1);
  assert.equal(action.recent_denials, 10);
});

test("cyber policy interrupts on its first denial and turn state can be cleared", () => {
  const governor = createGuardianDenialGovernor();
  const action = governor.recordDenial("turn-cyber", "cyber");
  assert.equal(action.kind, "interrupt_turn");
  assert.equal(action.newly_triggered, true);
  assert.equal(governor.clearTurn("turn-cyber"), true);
  assert.equal(governor.snapshot("turn-cyber"), undefined);
});

test("Guardian state is bounded and evicts idle turns", () => {
  let now = 0;
  const governor = createGuardianDenialGovernor({ maxTurns: 2, idleTtlMs: 10, now: () => now });
  governor.recordDenial("turn-a");
  now = 1;
  governor.recordDenial("turn-b");
  now = 2;
  governor.recordDenial("turn-c");
  assert.equal(governor.snapshot("turn-a"), undefined);
  now = 20;
  governor.recordNonDenial("turn-d");
  assert.equal(governor.snapshot("turn-b"), undefined);
  assert.equal(governor.snapshot("turn-c"), undefined);
  assert.throws(() => governor.recordDenial("turn-invalid", "unknown"), /unknown Guardian/);
});
