import assert from "node:assert/strict";
import test from "node:test";
import { createControlEngine } from "../src/control/index.mjs";
import { createOutboxWorker } from "../src/outbox-worker.mjs";

test("outbox polling is a managed task and cooperative shutdown closes the store", async () => {
  const lifecycle = [];
  const store = { close: async () => lifecycle.push("store:close") };
  let firstRun;
  const ran = new Promise((resolve) => { firstRun = resolve; });
  const relay = {
    runOnce: async ({ signal }) => {
      firstRun();
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  };
  const control = createControlEngine({ teardownTimeoutMs: 50 });
  const worker = createOutboxWorker({
    store,
    relay,
    control,
    config: { pollIntervalMs: 1 },
  });
  const task = await worker.start();
  await ran;
  assert.equal(control.taskSnapshot().tasks[0].name, "outbox.poll");
  await Promise.all([worker.close(new Error("test shutdown")), worker.close()]);
  await assert.rejects(task.result, /test shutdown/);
  assert.deepEqual(lifecycle, ["store:close"]);
  assert.equal(control.taskSnapshot().state, "closed");
});

test("outbox worker surfaces task failure and still closes resources", async () => {
  const store = { closed: 0, close: async () => { store.closed += 1; } };
  const relay = { runOnce: async () => { throw new Error("relay failed"); } };
  const control = createControlEngine({ teardownTimeoutMs: 50 });
  const worker = createOutboxWorker({ store, relay, control, config: { pollIntervalMs: 1 } });
  const task = await worker.start();
  await assert.rejects(task.result, /relay failed/);
  await worker.close();
  assert.equal(store.closed, 1);
});
