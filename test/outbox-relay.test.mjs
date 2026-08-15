import assert from "node:assert/strict";
import test from "node:test";
import { OutboxRelay, outboxConfig, verifyOutboxSignature } from "../src/outbox-relay.mjs";

function fakeStore(event) {
  const calls = [];
  return {
    calls,
    claimOutbox: async () => [{ outbox_id: "out-1", attempts: 0, event }],
    markOutboxPublished: async (value) => calls.push(["published", value]),
    markOutboxFailed: async (value) => { calls.push(["failed", value]); return { dead_lettered: value.max_attempts === 1 }; },
  };
}

const event = { specversion: "1.0", id: "evt-1", type: "crm.command.committed.v1", source: "urn:test", subject: "customer/1", time: new Date().toISOString(), tenant_id: "tenant-a", request_id: "req-1", data: {} };

test("relay signs and acknowledges a successfully published CloudEvent", async () => {
  const store = fakeStore(event); let request;
  const config = outboxConfig({ OUTBOX_TARGET_URL: "https://events.example.test/hook", OUTBOX_TENANT_IDS: "tenant-a", OUTBOX_HMAC_SECRET: "secret" });
  const relay = new OutboxRelay({ store, config, fetchImpl: async (_url, options) => { request = options; return { ok: true, status: 204 }; }, workerId: "worker-a" });
  assert.deepEqual(await relay.runOnce(), { claimed: 1, published: 1, failed: 0, dead_lettered: 0 });
  assert.equal(verifyOutboxSignature(request.body, request.headers["x-sumi-signature"], "secret"), true);
  assert.equal(request.headers["idempotency-key"], event.id);
  assert.equal(store.calls[0][0], "published");
});

test("relay schedules failures and moves exhausted events to dead letter", async () => {
  const store = fakeStore(event);
  const config = outboxConfig({ OUTBOX_TARGET_URL: "https://events.example.test/hook", OUTBOX_TENANT_IDS: "tenant-a", OUTBOX_MAX_ATTEMPTS: "1" });
  const relay = new OutboxRelay({ store, config, fetchImpl: async () => ({ ok: false, status: 503 }), workerId: "worker-a" });
  assert.deepEqual(await relay.runOnce(), { claimed: 1, published: 0, failed: 1, dead_lettered: 1 });
  assert.equal(store.calls[0][0], "failed");
});

test("production relay configuration requires HTTPS and an HMAC secret", () => {
  assert.throws(() => outboxConfig({ APP_ENV: "production", OUTBOX_TARGET_URL: "http://events.test", OUTBOX_TENANT_IDS: "tenant-a" }), /HTTPS/);
  assert.throws(() => outboxConfig({ APP_ENV: "production", OUTBOX_TARGET_URL: "https://events.test", OUTBOX_TENANT_IDS: "tenant-a" }), /HMAC/);
  assert.throws(() => outboxConfig({ APP_ENV: "production", OUTBOX_TARGET_URL: "https://events.test", OUTBOX_TENANT_IDS: "tenant-a", OUTBOX_HMAC_SECRET: "short" }), /32 characters/);
});
