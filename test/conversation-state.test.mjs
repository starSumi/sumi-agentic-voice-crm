import assert from "node:assert/strict";
import test from "node:test";
import { ConversationStateService } from "../src/application/index.ts";
import { CrmStore } from "../src/store.ts";

const context = Object.freeze({
  identity: Object.freeze({ tenant_id: "tenant-a", actor_id: "actor-a" }),
});

test("conversation service creates, reads and CAS-replaces flat state", async () => {
  const service = new ConversationStateService({ store: new CrmStore() });
  assert.deepEqual(await service.initialize(context, {
    conversation_id: "conversation-1",
    state: { active_customer_id: "customer-1", turn_count: 0 },
  }), {
    created: true,
    conversation_id: "conversation-1",
    revision: 0,
    state: { active_customer_id: "customer-1", turn_count: 0 },
  });
  assert.deepEqual(await service.replace(context, {
    conversation_id: "conversation-1",
    expected_revision: 0,
    state: { active_customer_id: "customer-1", turn_count: 1 },
  }), { replaced: true, conversation_id: "conversation-1", revision: 1 });
  assert.deepEqual(await service.read(context, { conversation_id: "conversation-1" }), {
    conversation_id: "conversation-1",
    revision: 1,
    state: { active_customer_id: "customer-1", turn_count: 1 },
  });
});

test("stale conversation revision fails without leaking the current state", async () => {
  const service = new ConversationStateService({ store: new CrmStore() });
  await service.initialize(context, { conversation_id: "conversation-conflict", state: { value: 1 } });
  await service.replace(context, { conversation_id: "conversation-conflict", expected_revision: 0, state: { value: 2 } });
  await assert.rejects(
    service.replace(context, { conversation_id: "conversation-conflict", expected_revision: 0, state: { value: 3 } }),
    (error) => error.code === "CRM_CONFLICT" && !error.state,
  );
});

test("conversation state validates identifiers, revisions and bounded JSON objects", async () => {
  const service = new ConversationStateService({ store: new CrmStore() });
  await assert.rejects(service.initialize(context, { conversation_id: "", state: {} }), /conversation_id/);
  await assert.rejects(service.initialize(context, { conversation_id: "valid", state: [] }), /must be an object/);
  await assert.rejects(service.initialize(context, { conversation_id: "valid", state: { callback() {} } }), /JSON serializable/);
  await service.initialize(context, { conversation_id: "valid", state: {} });
  await assert.rejects(service.replace(context, { conversation_id: "valid", expected_revision: -1, state: {} }), /non-negative/);
  await assert.rejects(service.replace(context, {
    conversation_id: "valid",
    expected_revision: 0,
    state: { oversized: "x".repeat(70_000) },
  }), /exceeds/);
});
