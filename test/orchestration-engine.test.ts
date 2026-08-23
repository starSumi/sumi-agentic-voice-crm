import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  TaskLifecycleTimeoutError,
  TaskStateConflictError,
  deterministicRetryDelay,
  pathsOverlap,
  runTaskLifecycle,
  selectRunnableTasks,
  topologicalOrder,
  transitionTask,
  validateOrchestrationSpec,
  validateTaskPlan,
} from "../orchestration/src/index.ts";
import {
  checkProjections,
  loadOrchestrationSpec,
  selectNext,
} from "../orchestration/cli.ts";

const plan = JSON.parse(
  await readFile(
    new URL("../orchestration/fixtures/change-plan.json", import.meta.url),
    "utf8",
  ),
);
const runtime = JSON.parse(
  await readFile(
    new URL("../orchestration/fixtures/change-state.json", import.meta.url),
    "utf8",
  ),
);

test("desired orchestration spec and generated projections are current", async () => {
  const spec = await loadOrchestrationSpec();
  validateOrchestrationSpec(spec);
  assert.ok(
    parseYaml(
      await readFile(
        new URL("../orchestration/orchestration.yaml", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.ok((await checkProjections()).includes(".codex/config.toml"));
});

test("dependency graph rejects cycles and missing nodes", () => {
  assert.throws(
    () =>
      topologicalOrder([
        { id: "a", depends_on: ["b"] },
        { id: "b", depends_on: ["a"] },
      ]),
    /cycle/,
  );
  assert.throws(
    () => topologicalOrder([{ id: "a", depends_on: ["missing"] }]),
    /missing node/,
  );
});

test("plan admits disjoint writers in parallel", async () => {
  const spec = await loadOrchestrationSpec();
  validateTaskPlan(plan, spec);
  assert.deepEqual(
    selectRunnableTasks(plan, runtime, spec).map(({ task_id }) => task_id),
    ["implement-runtime", "implement-contract"],
  );
  assert.deepEqual(
    await selectNext(
      "orchestration/fixtures/change-plan.json",
      "orchestration/fixtures/change-state.json",
    ),
    ["implement-runtime", "implement-contract"],
  );
});

test("path-prefix write conflicts serialize", async () => {
  const spec = await loadOrchestrationSpec();
  const conflicted = structuredClone(plan);
  conflicted.tasks.find(
    ({ task_id }) => task_id === "implement-contract",
  ).write_paths = ["src/application/services.ts"];
  const selected = selectRunnableTasks(conflicted, runtime, spec).map(
    ({ task_id }) => task_id,
  );
  assert.deepEqual(selected, ["implement-runtime"]);
  assert.equal(
    pathsOverlap("src/application", "src/application/services.ts"),
    true,
  );
  assert.equal(pathsOverlap("src/application", "contracts"), false);
});

test("task runtime transition uses version CAS and declared evidence", () => {
  const task = plan.tasks.find(
    ({ task_id }) => task_id === "implement-runtime",
  );
  const admitted = runtime.tasks.find(
    ({ task_id }) => task_id === task.task_id,
  );
  assert.throws(
    () =>
      transitionTask(task, admitted, {
        expected_version: 1,
        next_state: "running",
      }),
    TaskStateConflictError,
  );
  const running = transitionTask(task, admitted, {
    expected_version: 2,
    next_state: "running",
  });
  const verifying = transitionTask(task, running, {
    expected_version: 3,
    next_state: "verifying",
  });
  assert.throws(
    () =>
      transitionTask(task, verifying, {
        expected_version: 4,
        next_state: "completed",
      }),
    /missing completion evidence/,
  );
  const completed = transitionTask(task, verifying, {
    expected_version: 4,
    next_state: "completed",
    evidence: { diff: "sha256:diff", acceptance_results: "sha256:checks" },
  });
  assert.equal(completed.state, "completed");
});

test("retry jitter is stable and bounded", () => {
  const task = plan.tasks[2];
  const first = deterministicRetryDelay(task, 3);
  assert.equal(first, deterministicRetryDelay(task, 3));
  assert.ok(first > 0 && first <= task.retry.max_delay_ms);
});

test("parent cancellation is retry neutral even when work ignores AbortSignal", async () => {
  const parent = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const operation = runTaskLifecycle(
    () => {
      markStarted();
      return new Promise(() => {});
    },
    {
      signal: parent.signal,
      softTimeoutMs: 1000,
      hardGraceMs: 10,
      label: "cancelled task",
    },
  );
  await started;
  parent.abort(new Error("owner stopped"));
  await assert.rejects(
    operation,
    (error) =>
      error instanceof TaskLifecycleTimeoutError &&
      error.phase === "hard" &&
      error.retryEligible === false,
  );
});

test("soft timeout escalates to a retry-eligible hard timeout", async () => {
  await assert.rejects(
    runTaskLifecycle(() => new Promise(() => {}), {
      softTimeoutMs: 5,
      hardGraceMs: 5,
      label: "stuck task",
    }),
    (error) =>
      error instanceof TaskLifecycleTimeoutError &&
      error.phase === "hard" &&
      error.retryEligible === true,
  );
});
