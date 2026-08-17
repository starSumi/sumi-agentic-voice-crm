import assert from "node:assert/strict";
import test from "node:test";
import {
  ManagedTaskTimeoutError,
  createManagedTaskRegistry,
} from "../src/lifecycle/managed-task-registry.mjs";

test("managed tasks receive cooperative cancellation and close idempotently", async () => {
  const registry = createManagedTaskRegistry({ teardownTimeoutMs: 50 });
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const handle = registry.start("worker.poll", async (signal) => {
    started();
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  await ready;
  assert.deepEqual(registry.snapshot().tasks.map(({ name, status }) => ({ name, status })), [
    { name: "worker.poll", status: "running" },
  ]);
  await Promise.all([registry.close(), registry.close()]);
  assert.equal(handle.signal.aborted, true);
  assert.equal(registry.state, "closed");
  assert.deepEqual(registry.snapshot().tasks, []);
  assert.throws(() => registry.start("late", async () => {}), /cannot start from closed/);
});

test("a parent AbortSignal stops a managed task without an unhandled failure", async () => {
  const registry = createManagedTaskRegistry({ teardownTimeoutMs: 50 });
  const parent = new AbortController();
  const handle = registry.start("request.child", async (signal) => {
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }, { signal: parent.signal });
  parent.abort(Object.assign(new Error("caller left"), { name: "AbortError" }));
  await assert.rejects(handle.result, /caller left/);
  assert.equal(handle.snapshot().status, "cancelled");
  await registry.close();
});

test("teardown calls terminate only for an explicitly supervised stuck task", async () => {
  const terminations = [];
  const registry = createManagedTaskRegistry({ teardownTimeoutMs: 10 });
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  registry.start("process.extension", async () => {
    started();
    return await new Promise(() => {});
  }, {
    terminate: () => terminations.push("terminated"),
  });
  await ready;
  await assert.rejects(
    registry.close(),
    (error) => error instanceof AggregateError && error.errors[0] instanceof ManagedTaskTimeoutError,
  );
  assert.deepEqual(terminations, ["terminated"]);
  assert.equal(registry.state, "closed");
});

test("duplicate active task names fail closed", async () => {
  const registry = createManagedTaskRegistry({ teardownTimeoutMs: 50 });
  registry.start("unique", async (signal) => await new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  assert.throws(() => registry.start("unique", async () => {}), /already active/);
  await registry.close();
});
