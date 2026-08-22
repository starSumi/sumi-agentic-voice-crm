import assert from "node:assert/strict";
import test from "node:test";
import { CrmStore } from "../src/store.ts";

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

test("an expired interaction lease is recovered through an ordered WAL", () => {
  let clock = 1_000;
  const store = new CrmStore({ clock: () => clock, interactionLeaseMs: 100 });
  assert.deepEqual(store.beginInteraction(base), { replay: false });
  assert.throws(
    () => store.beginInteraction({ ...base, request_id: "req_active_retry_0000000001" }),
    (error) => error.code === "CRM_CONFLICT",
  );
  clock += 101;
  const recovered = { ...base, request_id: "req_recovered_00000000001" };
  assert.deepEqual(store.beginInteraction(recovered), { replay: false, recovered: true });
  store.checkpointInteraction({ ...recovered, understanding: { intent: "crm.search" } });
  store.completeInteraction({ ...recovered, response: { status: "completed", request_id: recovered.request_id }, http_status: 200 });
  assert.deepEqual(
    store.interactionWal(base.tenant_id, base.idempotency_key).map(({ sequence, entry_type }) => ({ sequence, entry_type })),
    [
      { sequence: 1, entry_type: "started" },
      { sequence: 2, entry_type: "recovered" },
      { sequence: 3, entry_type: "checkpointed" },
      { sequence: 4, entry_type: "completed" },
    ],
  );
  assert.equal(store.interactionFor(base.tenant_id, base.idempotency_key).recovery_count, 1);
});

test("an expired owner cannot complete or fail before CAS recovery", () => {
  let clock = 1_000;
  const store = new CrmStore({ clock: () => clock, interactionLeaseMs: 10 });
  const expired = {
    tenant_id: "tenant_demo",
    actor_id: "actor-a",
    request_id: "req_expired_owner_00000001",
    idempotency_key: "expired-owner-key",
    request_fingerprint: "c".repeat(64),
    input_type: "text",
    input_payload: { text: "lease" },
  };
  store.beginInteraction(expired);
  clock = 1_011;
  assert.throws(
    () => store.completeInteraction({ ...expired, response: { status: "completed" }, http_status: 200 }),
    (error) => error.code === "CRM_CONFLICT",
  );
  store.failInteraction({ ...expired, error_code: "UPSTREAM_UNAVAILABLE", error_message: "late", http_status: 503 });
  assert.equal(store.interactionFor(expired.tenant_id, expired.idempotency_key).status, "processing");
  assert.deepEqual(store.beginInteraction({ ...expired, request_id: "req_expired_owner_00000002" }), { replay: false, recovered: true });
});

test("a cancelled owner appends an abandonment record and releases the lease for CAS recovery", () => {
  let clock = 2_000;
  const store = new CrmStore({ clock: () => clock, interactionLeaseMs: 100 });
  const abandoned = {
    ...base,
    request_id: "req_abandoned_owner_000001",
    idempotency_key: "abandoned-owner-key",
    request_fingerprint: "d".repeat(64),
  };
  store.beginInteraction(abandoned);
  assert.deepEqual(store.abandonInteraction(abandoned), { released: true });
  assert.deepEqual(store.abandonInteraction(abandoned), { released: false });
  const recovered = { ...abandoned, request_id: "req_abandoned_owner_000002" };
  assert.deepEqual(store.beginInteraction(recovered), { replay: false, recovered: true });
  assert.deepEqual(
    store.interactionWal(abandoned.tenant_id, abandoned.idempotency_key).map(({ entry_type }) => entry_type),
    ["started", "abandoned", "recovered"],
  );
});
