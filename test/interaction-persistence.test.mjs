import assert from "node:assert/strict";
import test from "node:test";
import { CrmStore } from "../src/store.mjs";

const base = {
  tenant_id: "tenant_demo",
  actor_id: "actor-a",
  request_id: "req_01234567890123456789",
  idempotency_key: "interaction-key-001",
  request_fingerprint: "a".repeat(64),
  input_type: "text",
  input_payload: { text: "private request" },
};

test("the complete interaction can be replayed without re-running providers", () => {
  const store = new CrmStore();
  assert.deepEqual(store.beginInteraction(base), { replay: false });
  store.checkpointInteraction({ ...base, transcript: { text: "private request" }, understanding: { intent: "crm.search" }, provider_invocations: [{ provider: "mock", operation: "intent" }] });
  const response = { status: "completed", request_id: base.request_id };
  store.completeInteraction({ ...base, response, http_status: 200 });
  assert.deepEqual(store.beginInteraction(base), { replay: true, response, http_status: 200 });
  assert.equal(store.interactionFor(base.tenant_id, base.idempotency_key).provider_invocations.length, 1);
});

test("interaction idempotency rejects a different payload and replays failures", () => {
  const store = new CrmStore();
  store.beginInteraction(base);
  assert.throws(() => store.beginInteraction({ ...base, request_fingerprint: "b".repeat(64) }), /different request/);
  store.failInteraction({ ...base, error_code: "UPSTREAM_UNAVAILABLE", error_message: "provider unavailable", http_status: 503 });
  assert.throws(() => store.beginInteraction(base), (error) => error.code === "UPSTREAM_UNAVAILABLE");
});
