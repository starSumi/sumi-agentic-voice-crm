import assert from "node:assert/strict";
import test from "node:test";
import {
  AskService,
  normalizeAskCommand,
  normalizeReviewCommand,
  normalizeTtsCommand,
  ReviewService,
  TtsService,
} from "../src/application/index.mjs";
import { createRequestContext } from "../src/composition-root.mjs";
import { understanding } from "../src/contracts.mjs";

const REQUEST_ID = "req_progress0123456789abcdef";
const AUDIO_BYTES = Buffer.from("private audio bytes");
const TRANSCRIPT = "private customer transcript";

function context() {
  return createRequestContext({
    request_id: REQUEST_ID,
    identity: { tenant_id: "tenant_progress", actor_id: "actor_progress" },
  });
}

function askCommand(overrides = {}) {
  return normalizeAskCommand({
    idempotency_key: "progress-key-001",
    input: { type: "audio", data: AUDIO_BYTES, content_type: "audio/wav" },
    locale: "en-US",
    output_mode: "both",
    conversation_id: "conversation_progress",
    ...overrides,
  });
}

function progressPorts(overrides = {}) {
  return {
    now: () => 1_800_000_000_000,
    intentProviderName: "intent-provider",
    beginInteraction: async () => ({ replay: false }),
    checkpointInteraction: async () => {},
    completeInteraction: async () => {},
    failInteraction: async () => {},
    persistInputAudio: async () => ({
      asset: {
        asset_id: "ast_input_progress",
        url: "https://storage.invalid/audio?signature=private",
        mime_type: "audio/wav",
        status: "ready",
      },
      object_key: "private/storage/key.wav",
      byte_length: AUDIO_BYTES.length,
      sha256: "a".repeat(64),
    }),
    recordInputAsset: async () => {},
    transcribe: async () => ({
      text: TRANSCRIPT,
      language: "en",
      confidence: 0.98,
      provider: "asr-provider",
      model: "asr-model",
      duration_ms: 7,
    }),
    understand: async () => understanding({
      intent: "crm.search",
      confidence: 0.95,
      entities: { customer: { value: "private customer entity" } },
      transcript: TRANSCRIPT,
      language: "en",
      model: "intent-model",
    }),
    executeCrm: async () => ({
      action: "read_only",
      resource: { type: "search", id: "result_progress" },
      aggregate_version: 3,
    }),
    createReview: async () => ({ id: "rev_progress" }),
    ttsDefaultFormat: () => "mp3",
    synthesize: async () => ({
      data_base64: Buffer.from("private synthesized audio").toString("base64"),
      provider: "tts-provider",
      model: "tts-model",
      mime_type: "audio/mpeg",
    }),
    persistAudioAsset: async () => ({
      asset: {
        asset_id: "ast_tts_progress",
        url: "https://storage.invalid/tts?signature=private",
        mime_type: "audio/mpeg",
        status: "ready",
      },
      object_key: "private/storage/tts.mp3",
      byte_length: 25,
      sha256: "b".repeat(64),
    }),
    recordTts: async (_key, _fingerprint, asset) => asset,
    replayTts: async () => undefined,
    decideReview: async (args) => ({
      review_id: args.review_id,
      status: "approved",
      decision: { decision: args.decision },
    }),
    validateResponse: (_schema, response) => response,
    ...overrides,
  };
}

test("AskService emits ordered, flat, redacted progress milestones", async () => {
  const events = [];
  const service = new AskService(progressPorts({
    progressSink: (event) => events.push(event),
  }));

  const outcome = await service.execute(context(), askCommand());

  assert.equal(outcome.kind, "ask.completed");
  assert.deepEqual(events.map((event) => event.type), [
    "interaction.started",
    "input.asset.persisted",
    "transcript.created",
    "understanding.created",
    "crm.committed",
    "tts.asset.created",
    "interaction.completed",
  ]);
  for (const event of events) {
    assert.equal(event.request_id, REQUEST_ID);
    assert.equal(event.tenant_id, "tenant_progress");
    assert.equal(event.actor_id, "actor_progress");
    assert.equal(event.conversation_id, "conversation_progress");
    assert.equal(typeof event.occurred_at, "string");
    assert.ok(Object.values(event).every((value) => value === null || ["string", "number", "boolean"].includes(typeof value)));
    assert.doesNotThrow(() => JSON.stringify(event));
  }

  assert.deepEqual(
    Object.fromEntries(Object.entries(events[1]).filter(([key]) => ["asset_id", "sha256", "byte_length"].includes(key))),
    { asset_id: "ast_input_progress", sha256: "a".repeat(64), byte_length: AUDIO_BYTES.length },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(events[2]).filter(([key]) => ["language", "provider", "model", "length"].includes(key))),
    { language: "en", provider: "asr-provider", model: "asr-model", length: TRANSCRIPT.length },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(events[3]).filter(([key]) => ["intent", "confidence", "needs_confirmation", "model"].includes(key))),
    { intent: "crm.search", confidence: 0.95, needs_confirmation: false, model: "intent-model" },
  );
  assert.equal(events[4].resource, "search/result_progress");
  assert.deepEqual(
    Object.fromEntries(Object.entries(events[5]).filter(([key]) => ["asset_id", "mime", "status"].includes(key))),
    { asset_id: "ast_tts_progress", mime: "audio/mpeg", status: "ready" },
  );

  const serialized = JSON.stringify(events);
  for (const forbidden of [
    TRANSCRIPT,
    AUDIO_BYTES.toString("base64"),
    "private synthesized audio",
    "private customer entity",
    "signature=private",
    "private/storage",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `progress leaked ${forbidden}`);
  }
});

test("AskService emits review, replay, and failure milestones", async (t) => {
  await t.test("review required", async () => {
    const events = [];
    const service = new AskService(progressPorts({
      progressSink: (event) => events.push(event),
      understand: async () => understanding({
        intent: "crm.deal.update_stage",
        confidence: 0.9,
        entities: { deal: { value: "private-deal" } },
        transcript: TRANSCRIPT,
        language: "en",
        model: "intent-model",
      }),
    }));
    const outcome = await service.execute(context(), askCommand({ output_mode: "text" }));
    assert.equal(outcome.kind, "ask.review_required");
    assert.deepEqual(events.slice(-2).map((event) => event.type), [
      "review.required",
      "interaction.completed",
    ]);
    assert.equal(events.at(-2).review_id, "rev_progress");
  });

  await t.test("replay", async () => {
    const events = [];
    const response = { request_id: REQUEST_ID, status: "completed" };
    const service = new AskService(progressPorts({
      progressSink: (event) => events.push(event),
      beginInteraction: async () => ({ replay: true, response }),
      transcribe: async () => { throw new Error("provider ran during replay"); },
    }));
    const outcome = await service.execute(context(), askCommand());
    assert.equal(outcome.kind, "ask.replayed");
    assert.deepEqual(events.map((event) => event.type), [
      "interaction.started",
      "interaction.replayed",
    ]);
  });

  await t.test("failed", async () => {
    const events = [];
    const failure = Object.assign(new Error("private prompt and transcript"), {
      code: "UPSTREAM_UNAVAILABLE",
    });
    const service = new AskService(progressPorts({
      progressSink: (event) => events.push(event),
      understand: async () => { throw failure; },
    }));
    await assert.rejects(service.execute(context(), askCommand()), failure);
    assert.equal(events.at(-1).type, "interaction.failed");
    assert.equal(events.at(-1).error_code, "UPSTREAM_UNAVAILABLE");
    assert.equal(JSON.stringify(events.at(-1)).includes(failure.message), false);
  });
});

test("sink failures are isolated and TTS/Review services emit milestones", async () => {
  const failingSink = async () => { throw new Error("sink unavailable"); };
  const ask = new AskService(progressPorts({ progressSink: failingSink }));
  const askOutcome = await ask.execute(context(), askCommand({ output_mode: "text" }));
  assert.equal(askOutcome.kind, "ask.completed");

  const events = [];
  const ports = progressPorts({ eventSink: { emit: (event) => events.push(event) } });
  const tts = new TtsService(ports);
  const review = new ReviewService(ports);
  await tts.execute(context(), normalizeTtsCommand({
    idempotency_key: "tts-progress-key",
    text: "speak safely",
    language: "en-US",
    format: "mp3",
  }));
  await review.execute(context(), normalizeReviewCommand({
    idempotency_key: "review-progress-key",
    review_id: "rev_progress",
    decision: "approve",
  }));
  assert.deepEqual(events.map((event) => event.type), [
    "tts.asset.created",
    "review.decided",
  ]);
});
