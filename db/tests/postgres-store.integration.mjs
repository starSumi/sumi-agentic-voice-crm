import assert from "node:assert/strict";
import { PostgresCrmStore } from "../../src/postgres-store.mjs";

const store = new PostgresCrmStore({ connectionString: process.env.DATABASE_URL });
const identity = {
  tenant_id: "00000000-0000-4000-8000-000000000001",
  actor_id: "actor-a",
};

try {
  const command = {
    ...identity,
    request_id: "req_runtime_postgres_0001",
    idempotency_key: "runtime-pg-key-0001",
    request_fingerprint: "3".repeat(64),
    intent: "crm.customer.create",
    entities: { customer: { name: "Runtime Customer", preferred_language: "en-US" } },
  };
  const first = await store.execute(command);
  const replay = await store.execute({ ...command, request_id: "req_runtime_postgres_0002" });
  assert.deepEqual(replay, first);
  await assert.rejects(
    store.execute({ ...command, request_id: "req_runtime_postgres_0003", request_fingerprint: "4".repeat(64) }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );

  const review = await store.createReview({
    ...identity,
    request_id: "req_runtime_postgres_0004",
    idempotency_key: "runtime-review-0001",
    request_fingerprint: "5".repeat(64),
    understanding: { intent: "crm.customer.create", entities: { customer: { name: "Needs Review" } } },
  });
  assert.equal(review.status, "open");
  const replayReview = await store.createReview({
    ...identity,
    request_id: "req_runtime_postgres_0005",
    idempotency_key: "runtime-review-0001",
    request_fingerprint: "5".repeat(64),
    understanding: { intent: "crm.customer.create", entities: { customer: { name: "Needs Review" } } },
  });
  assert.deepEqual(replayReview, review);

  const ttsAsset = {
    asset_id: "ast_01234567890123456789",
    url: "/v1/assets/ast_01234567890123456789",
    mime_type: "audio/mpeg",
    duration_ms: 500,
    status: "ready",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const ttsKey = `${identity.tenant_id}:runtime-tts-0001`;
  const assetMetadata = { object_key: "voice-crm/tenant-a/tts/asset.mp3", byte_length: 12, sha256: "a".repeat(64) };
  const storedTts = await store.recordTts(ttsKey, "6".repeat(64), ttsAsset, { ...identity, request_id: "req_runtime_postgres_0006", ...assetMetadata });
  assert.deepEqual(await store.replayTts(ttsKey, "6".repeat(64)), storedTts);
  await assert.rejects(store.replayTts(ttsKey, "7".repeat(64)), (error) => error.code === "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(await store.assetFor(identity.tenant_id, ttsAsset.asset_id), ttsAsset);
  assert.equal(await store.assetFor("00000000-0000-4000-8000-000000000002", ttsAsset.asset_id), undefined);
  const duplicateAsset = await store.recordTts(`${identity.tenant_id}:runtime-tts-0002`, "8".repeat(64), ttsAsset, { ...identity, request_id: "req_runtime_postgres_0006b", ...assetMetadata });
  assert.deepEqual(duplicateAsset, ttsAsset);

  const interaction = {
    ...identity,
    request_id: "req_runtime_interaction_0001",
    idempotency_key: "runtime-interaction-0001",
    request_fingerprint: "9".repeat(64),
    input_type: "text",
    input_payload: { text: "private interaction input", locale: "en-US" },
  };
  assert.deepEqual(await store.beginInteraction(interaction), { replay: false });
  await store.checkpointInteraction({ ...interaction, transcript: { text: "private transcript" }, understanding: { intent: "crm.search" }, provider_invocations: [{ operation: "intent", status: "succeeded" }] });
  const interactionResponse = { status: "completed", request_id: interaction.request_id, answer: { text: "private answer" } };
  await store.completeInteraction({ ...interaction, response: interactionResponse, http_status: 200 });
  assert.deepEqual(await store.beginInteraction(interaction), { replay: true, response: interactionResponse, http_status: 200 });
  const inspection = await store.pool.connect();
  try {
    await inspection.query("begin");
    await inspection.query("select set_config('app.tenant_id', $1, true)", [identity.tenant_id]);
    const raw = (await inspection.query("select input_payload_ciphertext,transcript_ciphertext,understanding_ciphertext,response_ciphertext from voice_interactions where tenant_id=$1 and request_id=$2", [identity.tenant_id, interaction.request_id])).rows[0];
    assert.ok(Object.values(raw).every((value) => String(value).startsWith("v1.")));
    assert.doesNotMatch(JSON.stringify(raw), /private interaction|private transcript|private answer/);
    await inspection.query("rollback");
  } finally {
    inspection.release();
  }

  const decision = await store.decideReview({
    ...identity,
    review_id: review.id,
    decision: "reject",
    idempotency_key: "runtime-review-decision-0001",
    request_id: "req_runtime_postgres_0007",
  });
  assert.equal(decision.status, "rejected");
  const rawReviewId = review.id.slice(4).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const replayDecision = await store.decideReview({
    ...identity,
    review_id: rawReviewId,
    decision: "reject",
    idempotency_key: "runtime-review-decision-0001",
    request_id: "req_runtime_postgres_0008",
  });
  assert.deepEqual(replayDecision, decision);
  await assert.rejects(store.decideReview({
    ...identity,
    review_id: rawReviewId,
    decision: "approve",
    idempotency_key: "runtime-review-decision-0001",
    request_id: "req_runtime_postgres_0009",
  }), (error) => error.code === "IDEMPOTENCY_CONFLICT");

  const events = await store.events(identity.tenant_id, identity.actor_id);
  assert.ok(events.some((event) => event.type === "crm.command.committed.v1"));
  assert.ok(events.some((event) => event.type === "crm.review.requested.v1"));
  assert.equal(events.filter((event) => event.type === "tts.asset.created.v1").length, 1);
  assert.ok(events.every((event) => event.tenant_id === identity.tenant_id));
  const claimed = await store.claimOutbox({ tenant_id: identity.tenant_id, worker_id: "integration-worker", batch_size: 100 });
  assert.ok(claimed.length >= 3);
  await store.markOutboxFailed({ tenant_id: identity.tenant_id, worker_id: "integration-worker", outbox_id: claimed[0].outbox_id, error: "fixture failure", max_attempts: 1 });
  for (const row of claimed.slice(1)) await store.markOutboxPublished({ tenant_id: identity.tenant_id, worker_id: "integration-worker", outbox_id: row.outbox_id });
  console.log("postgres runtime adapter passed: encrypted interaction replay, durable CRM/TTS, tenant assets, reviews and outbox leases verified");
} finally {
  await store.close();
}
