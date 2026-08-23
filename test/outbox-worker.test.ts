import assert from "node:assert/strict";
import test from "node:test";
import {
  createControlEngine,
  createManagedTaskRegistry,
} from "../src/control/index.ts";
import { outboxConfig, type OutboxRelay } from "../src/outbox-relay.ts";
import { createOutboxWorker } from "../src/outbox-worker.ts";

type RelayPort = Pick<OutboxRelay, "runOnce">;

const config = () =>
  outboxConfig({
    OUTBOX_TARGET_URL: "https://events.example.test/hook",
    OUTBOX_TENANT_IDS: "tenant-a",
    OUTBOX_POLL_INTERVAL_MS: "1",
  });

test("outbox polling is a managed task and cooperative shutdown closes the store", async () => {
  const lifecycle: string[] = [];
  const store = {
    close: async () => {
      lifecycle.push("store:close");
    },
  };
  let firstRun: () => void = () => {};
  const ran = new Promise<void>((resolve) => {
    firstRun = resolve;
  });
  const relay: RelayPort = {
    runOnce: async ({
      signal,
    }: { signal?: AbortSignal } = {}): Promise<never> => {
      assert.ok(signal);
      firstRun();
      return await new Promise<never>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  };
  const tasks = createManagedTaskRegistry({ teardownTimeoutMs: 50 });
  const control = createControlEngine({ tasks });
  const worker = createOutboxWorker({
    store,
    relay,
    control,
    config: config(),
  });
  const task = await worker.start();
  await ran;
  assert.equal(tasks.snapshot().tasks.at(0)?.name, "outbox.poll");
  await Promise.all([worker.close(new Error("test shutdown")), worker.close()]);
  await assert.rejects(task.result, /test shutdown/);
  assert.deepEqual(lifecycle, ["store:close"]);
  assert.equal(tasks.snapshot().state, "closed");
});

test("outbox worker surfaces task failure and still closes resources", async () => {
  const store = {
    closed: 0,
    close: async () => {
      store.closed += 1;
    },
  };
  const relay: RelayPort = {
    runOnce: async (): Promise<never> => {
      throw new Error("relay failed");
    },
  };
  const control = createControlEngine({ teardownTimeoutMs: 50 });
  const worker = createOutboxWorker({
    store,
    relay,
    control,
    config: config(),
  });
  const task = await worker.start();
  await assert.rejects(task.result, /relay failed/);
  await worker.close();
  assert.equal(store.closed, 1);
});
