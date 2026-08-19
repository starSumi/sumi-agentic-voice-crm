import assert from "node:assert/strict";
import test from "node:test";
import { checkControlPlanePolicy } from "../scripts/check-control-plane-policy.mjs";

const load = async () => await checkControlPlanePolicy();

test("control-plane policy binds controllers to existing implementations", async () => {
  const policy = await load();
  assert.equal(policy.model.pattern, "declarative-controller-reconciliation");
  assert.equal(
    policy.resource_contract.status_writer,
    "owning-controller-only",
  );
  assert.equal(policy.controllers.length, 7);
  assert.equal(
    policy.controllers.find(({ id }) => id === "extension")?.restart_policy,
    "explicit-only",
  );
});

test("control-plane policy rejects event streams as durable truth", async () => {
  const policy = structuredClone(await load());
  policy.controllers[0].source_of_truth = "event-stream";
  await assert.rejects(
    () => checkControlPlanePolicy({ policy }),
    /cannot use an event stream as source of truth/,
  );
});

test("control-plane policy rejects multiple owners for one status resource", async () => {
  const policy = structuredClone(await load());
  policy.controllers[1].resource = policy.controllers[0].resource;
  await assert.rejects(
    () => checkControlPlanePolicy({ policy }),
    /multiple controllers own resource status/,
  );
});

test("control-plane policy rejects missing implementation evidence", async () => {
  const policy = structuredClone(await load());
  policy.controllers[0].implementations = ["src/control/not-present.ts"];
  await assert.rejects(
    () => checkControlPlanePolicy({ policy }),
    /implementation is missing/,
  );
});

test("control-plane policy rejects missing controller verification evidence", async () => {
  const policy = structuredClone(await load());
  policy.controllers[0].verification_tests = ["test/not-present.test.mjs"];
  await assert.rejects(
    () => checkControlPlanePolicy({ policy }),
    /verification test is missing/,
  );
});

test("control-plane policy rejects a reconciler without a state-driven wakeup", async () => {
  const policy = structuredClone(await load());
  const controller = policy.controllers.find(({ id }) => id === "message-job");
  controller.wakeups = ["enqueue"];
  await assert.rejects(
    () => checkControlPlanePolicy({ policy }),
    /reconciler needs a state-driven wakeup/,
  );
});
