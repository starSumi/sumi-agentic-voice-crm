import test from "node:test";
import assert from "node:assert/strict";
import { CrmStore } from "../src/store.ts";
import { assertTenant } from "../src/contracts.ts";
import { providerReadiness } from "../src/providers.ts";

test("CRM mutations are tenant-scoped and idempotent", () => {
  const store = new CrmStore();
  const first = store.execute({ tenant_id: "tenant_demo", actor_id: "actor", idempotency_key: "runtime-key-1", intent: "crm.deal.update_stage", entities: { deal: { value: "d1" }, stage: { value: "Negotiation" } }, request_id: "req_000000000000000000000001" });
  const replay = store.execute({ tenant_id: "tenant_demo", actor_id: "actor", idempotency_key: "runtime-key-1", intent: "crm.deal.update_stage", entities: { deal: { value: "d1" }, stage: { value: "Negotiation" } }, request_id: "req_000000000000000000000002" });
  assert.deepEqual(replay, first);
  assert.throws(() => store.execute({ tenant_id: "tenant_other", actor_id: "actor", idempotency_key: "runtime-key-2", intent: "crm.deal.update_stage", entities: { deal: { value: "d1" }, stage: { value: "Closed" } }, request_id: "req_000000000000000000000003" }), /deal not found/);
  assert.throws(() => store.execute({ tenant_id: "tenant_demo", actor_id: "actor", idempotency_key: "runtime-key-1", intent: "crm.customer.create", entities: { customer: { name: "Other" } }, request_id: "req_000000000000000000000004" }), (error) => error.code === "IDEMPOTENCY_CONFLICT");
});

test("tenant binding rejects malformed tenant ids and mismatched JWT claims", () => {
  assert.throws(() => assertTenant(new Headers({ authorization: "Bearer actor", "x-tenant-id": "bad tenant" })), (error) => error.code === "INVALID_REQUEST");
  const payload = Buffer.from(JSON.stringify({ tenant_id: "tenant_other" })).toString("base64url");
  assert.throws(() => assertTenant(new Headers({ authorization: `Bearer eyJhbGciOiJub25lIn0.${payload}.sig`, "x-tenant-id": "tenant_demo" })), (error) => error.code === "FORBIDDEN");
});

test("non-mock providers keep readiness false without an adapter signal", () => {
  const old = process.env.ASR_PROVIDER;
  process.env.ASR_PROVIDER = "cloud-asr";
  delete process.env.ASR_READY;
  try { assert.equal(providerReadiness().ready, false); }
  finally { if (old === undefined) delete process.env.ASR_PROVIDER; else process.env.ASR_PROVIDER = old; }
});

test("audit and outbox are emitted together with a committed mutation", () => {
  const store = new CrmStore();
  store.execute({ tenant_id: "tenant_demo", actor_id: "actor", idempotency_key: "runtime-key-3", intent: "crm.deal.update_stage", entities: { deal: { value: "d1" }, stage: { value: "Negotiation" } }, request_id: "req_000000000000000000000005" });
  assert.equal(store.events().length, 1);
  assert.equal(store.outbox().length, 1);
  assert.equal(store.audits().length, 1);
  assert.equal(store.events()[0].tenant_id, "tenant_demo");
  assert.equal(store.audits()[0].decision, "committed");
});

test("TTS records are tenant-bound and reject fingerprint conflicts", () => {
  const store = new CrmStore();
  const asset = { asset_id: "ast_01234567890123456789", url: "/v1/assets/ast_01234567890123456789", mime_type: "audio/mpeg", status: "ready" };
  store.recordTts("tenant_demo:tts-key", "fingerprint-a", asset, { tenant_id: "tenant_demo", request_id: "req_000000000000000000000006" });
  assert.deepEqual(store.assetFor("tenant_demo", asset.asset_id), asset);
  assert.equal(store.assetFor("tenant_other", asset.asset_id), undefined);
  assert.equal(store.events()[0].type, "tts.asset.created.v1");
  assert.throws(() => store.replayTts("tenant_demo:tts-key", "fingerprint-b"), (error) => error.code === "IDEMPOTENCY_CONFLICT");
});

test("low-confidence review uses the same idempotency boundary", () => {
  const store = new CrmStore();
  const args = { tenant_id: "tenant_demo", actor_id: "actor", request_id: "req_000000000000000000000007", idempotency_key: "review-key-1", request_fingerprint: "review-fingerprint", understanding: { intent: "crm.customer.create", entities: { customer: { name: "Unknown" } } } };
  const first = store.createReview(args);
  const replay = store.createReview({ ...args, request_id: "req_000000000000000000000008" });
  assert.deepEqual(replay, first);
  assert.equal(store.events().length, 1);
  assert.equal(store.outbox().length, 1);
});
