import assert from "node:assert/strict";
import test from "node:test";
import { consumeEvent } from "../src/event-consumer.ts";
import { createMemoryMessageJobQueue } from "../src/message-job-queue.ts";

test("event consumer completes one receipt and treats replay as duplicate", async () => {
  const store = createMemoryMessageJobQueue();
  let calls = 0;
  const input = {
    store,
    tenant_id: "tenant_demo",
    consumer_id: "crm-indexer",
    event: { id: "evt-1", type: "crm.deal.updated.v1" },
    worker_id: "worker-a",
    handler: async () => {
      calls += 1;
      return { indexed: true };
    },
  };
  assert.deepEqual(await consumeEvent(input), {
    duplicate: false,
    completed: true,
    result: { indexed: true },
  });
  assert.deepEqual(await consumeEvent(input), {
    duplicate: true,
    completed: false,
  });
  assert.equal(calls, 1);
});

test("event consumer releases failed handlers for retry", async () => {
  const store = createMemoryMessageJobQueue();
  const input = {
    store,
    tenant_id: "tenant_demo",
    consumer_id: "crm-indexer",
    event: { id: "evt-2", type: "crm.deal.updated.v1" },
    worker_id: "worker-a",
    handler: async () => {
      throw new Error("temporary failure");
    },
  };
  await assert.rejects(consumeEvent(input), /temporary failure/);
  let calls = 0;
  await assert.doesNotReject(
    consumeEvent({
      ...input,
      worker_id: "worker-b",
      handler: async () => {
        calls += 1;
      },
    }),
  );
  assert.equal(calls, 1);
});
