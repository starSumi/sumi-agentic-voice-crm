import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const REQUIRED_INVARIANTS = new Set([
  "events-wake-reconciliation-but-never-define-truth",
  "controllers-reobserve-before-effect",
  "one-controller-owns-each-status-resource",
  "status-never-mutates-spec",
  "ready-requires-current-observed-generation",
  "effects-are-idempotent-or-cas-guarded",
  "leases-expire-and-stale-owners-cannot-commit",
  "finalization-is-bounded-and-observable",
  "authorization-precedes-side-effects",
  "model-output-is-untrusted",
  "durable-evidence-precedes-verified",
  "cancellation-is-neutral-to-availability-circuits",
]);
const EPHEMERAL_TRUTH_SOURCES = new Set([
  "event-stream",
  "notification-stream",
  "progress-stream",
  "sse-stream",
]);

export async function checkControlPlanePolicy({
  root = process.cwd(),
  schema,
  policy,
} = {}) {
  const resolvedSchema =
    schema ??
    JSON.parse(
      await readFile(
        resolve(root, "contracts/control-plane-policy.schema.json"),
        "utf8",
      ),
    );
  const resolvedPolicy =
    policy ??
    JSON.parse(
      await readFile(
        resolve(root, "contracts/control-plane-policy.json"),
        "utf8",
      ),
    );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(resolvedSchema);
  if (!validate(resolvedPolicy)) {
    throw new Error(
      `control-plane policy schema failed: ${ajv.errorsText(validate.errors)}`,
    );
  }

  assert.deepEqual(new Set(resolvedPolicy.invariants), REQUIRED_INVARIANTS);
  assert.equal(resolvedPolicy.model.wakeup, "events-are-hints");
  assert.equal(resolvedPolicy.model.decision, "level-triggered");
  assert.equal(resolvedPolicy.model.source_of_truth, "durable-state");
  assert.equal(
    resolvedPolicy.resource_contract.scope,
    "new-public-declarative-resources",
  );
  assert.equal(
    resolvedPolicy.agent_semantics.model_output,
    "untrusted-proposal",
  );
  assert.equal(
    resolvedPolicy.retry_policy.jitter,
    "required-before-horizontal-scale",
  );

  const controllerIds = new Set();
  const resources = new Set();
  for (const controller of resolvedPolicy.controllers) {
    assert.ok(
      !controllerIds.has(controller.id),
      `duplicate controller id: ${controller.id}`,
    );
    assert.ok(
      !resources.has(controller.resource),
      `multiple controllers own resource status: ${controller.resource}`,
    );
    controllerIds.add(controller.id);
    resources.add(controller.resource);
    assert.ok(
      !EPHEMERAL_TRUTH_SOURCES.has(controller.source_of_truth),
      `${controller.id} cannot use an event stream as source of truth`,
    );
    for (const implementation of controller.implementations) {
      assert.ok(
        existsSync(resolve(root, implementation)),
        `${controller.id} implementation is missing: ${implementation}`,
      );
    }
    for (const verificationTest of controller.verification_tests) {
      assert.ok(
        existsSync(resolve(root, verificationTest)),
        `${controller.id} verification test is missing: ${verificationTest}`,
      );
    }
    if (controller.mode === "reconciled") {
      assert.ok(
        controller.wakeups.includes("poll") ||
          controller.wakeups.includes("lease-expiry"),
        `${controller.id} reconciler needs a state-driven wakeup`,
      );
    }
  }

  for (const id of ["extension", "managed-task"]) {
    const controller = resolvedPolicy.controllers.find(
      (candidate) => candidate.id === id,
    );
    assert.equal(controller?.mode, "governed-lifecycle");
    assert.equal(controller?.restart_policy, "explicit-only");
  }

  return resolvedPolicy;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const policy = await checkControlPlanePolicy();
  console.log(
    `control-plane policy passed: ${policy.controllers.length} controllers, ${policy.invariants.length} invariants`,
  );
}
