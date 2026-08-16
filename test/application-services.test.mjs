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
import { validateProtocol } from "../src/protocol-validation.mjs";

const REQUEST_ID = "req_0123456789abcdef01234567";

function context(requestId = REQUEST_ID) {
  return createRequestContext({
    request_id: requestId,
    traceparent: "00-test",
    identity: { tenant_id: "tenant_demo", actor_id: "actor-a" },
  });
}

function readUnderstanding(transcript = "find acme") {
  return understanding({
    intent: "crm.search",
    confidence: 0.99,
    entities: {},
    missing: [],
    needs_confirmation: false,
    transcript,
    language: "zh",
    model: "intent-test-1",
  });
}

function asset(overrides = {}) {
  return {
    asset_id: "ast_0123456789abcdef0123",
    url: "/v1/assets/ast_0123456789abcdef0123",
    mime_type: "audio/mpeg",
    status: "ready",
    provider: "test",
    model: "tts-test-1",
    ...overrides,
  };
}

function askFixture(overrides = {}) {
  const calls = {
    begin: [],
    checkpoint: [],
    complete: [],
    failed: [],
    reviews: [],
    crm: [],
  };
  const ports = {
    beginInteraction: async (args) => { calls.begin.push(args); return { replay: false }; },
    checkpointInteraction: async (args) => { calls.checkpoint.push(args); },
    completeInteraction: async (args) => { calls.complete.push(args); },
    failInteraction: async (args) => { calls.failed.push(args); },
    createReview: async (args) => {
      calls.reviews.push(args);
      return {
        id: "rev_abcd",
        expires_at: "2030-01-01T00:00:00.000Z",
      };
    },
    executeCrm: async (args) => {
      calls.crm.push(args);
      return { action: "read_only", resource: null, aggregate_version: 0 };
    },
    recordInputAsset: async () => {},
    recordTts: async (_key, _fingerprint, persisted) => persisted,
    transcribe: async () => ({
      text: "find acme",
      language: "zh",
      confidence: 0.98,
      provider: "test",
      model: "asr-test-1",
      duration_ms: 1,
    }),
    understand: async (transcript) => readUnderstanding(transcript),
    synthesize: async () => asset({ data_base64: Buffer.from("audio").toString("base64") }),
    ttsDefaultFormat: () => "mp3",
    persistInputAudio: async () => ({
      asset: asset({ mime_type: "audio/wav" }),
      object_key: "tenant/input/audio.wav",
      byte_length: 10,
      sha256: "a".repeat(64),
    }),
    persistAudioAsset: async (generated) => ({ asset: generated }),
    validateResponse: validateProtocol,
    intentProviderName: "test",
    now: () => 100,
    ...overrides,
  };
  return { service: new AskService(ports), calls };
}

function textCommand(overrides = {}) {
  return normalizeAskCommand({
    idempotency_key: "ask-key-001",
    input: { type: "text", text: " find acme " },
    locale: "zh-CN",
    output_mode: "text",
    conversation_id: "conversation-a",
    ...overrides,
  });
}

test("AskService completes a read-only command without HTTP and binds conversation_id to idempotency", async () => {
  const { service, calls } = askFixture();
  const first = await service.execute(context(), textCommand());
  const second = await service.execute(
    context("req_1123456789abcdef01234567"),
    textCommand({
      idempotency_key: "ask-key-002",
      conversation_id: "conversation-b",
    }),
  );

  assert.equal(first.kind, "ask.completed");
  assert.equal(first.response.status, "completed");
  assert.equal(second.kind, "ask.completed");
  assert.equal(calls.crm.length, 2);
  assert.equal(calls.reviews.length, 0);
  assert.equal(calls.complete[0].outcome, "completed");
  assert.equal(calls.begin[0].input_payload.conversation_id, "conversation-a");
  assert.equal(calls.begin[1].input_payload.conversation_id, "conversation-b");
  assert.notEqual(calls.begin[0].request_fingerprint, calls.begin[1].request_fingerprint);
});

test("AskService forces every mutating understanding through review", async () => {
  const mutation = understanding({
    intent: "crm.deal.update_stage",
    confidence: 0.99,
    entities: {
      deal: { value: "d1" },
      stage: { value: "Negotiation" },
    },
    needs_confirmation: false,
    transcript: "move deal",
    language: "en",
    model: "intent-test-1",
  });
  const { service, calls } = askFixture({
    understand: async () => mutation,
    executeCrm: async () => { throw new Error("mutation bypassed review"); },
  });

  const outcome = await service.execute(
    context(),
    textCommand({ input: { type: "text", text: "move deal" } }),
  );

  assert.equal(outcome.kind, "ask.review_required");
  assert.equal(outcome.response.understanding.needs_confirmation, true);
  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.complete[0].outcome, "review_required");
});

test("AskService replays a completed interaction without invoking providers or CRM", async () => {
  const response = {
    request_id: REQUEST_ID,
    status: "completed",
    input: { type: "text", transcript: "find acme" },
    understanding: readUnderstanding(),
    answer: { text: "done", language: "zh-CN" },
    crm: { action: "read_only", resource: null, aggregate_version: 0 },
  };
  const { service, calls } = askFixture({
    beginInteraction: async (args) => {
      calls.begin.push(args);
      return { replay: true, response, http_status: 200 };
    },
    understand: async () => { throw new Error("provider must not run for replay"); },
    executeCrm: async () => { throw new Error("CRM must not run for replay"); },
  });

  const outcome = await service.execute(context(), textCommand());

  assert.equal(outcome.kind, "ask.replayed");
  assert.deepEqual(outcome.response, response);
  assert.equal(calls.checkpoint.length, 0);
  assert.equal(calls.complete.length, 0);
});

test("TtsService and ReviewService delegate normalized commands to runtime ports", async () => {
  const calls = { synthesize: [], persist: [], record: [], decide: [] };
  const tts = new TtsService({
    replayTts: async () => undefined,
    synthesize: async (...args) => {
      calls.synthesize.push(args);
      return asset({ data_base64: Buffer.from("tts").toString("base64") });
    },
    persistAudioAsset: async (...args) => {
      calls.persist.push(args);
      return {
        asset: asset(),
        object_key: "tenant/tts/asset.mp3",
        byte_length: 3,
        sha256: "b".repeat(64),
      };
    },
    recordTts: async (...args) => {
      calls.record.push(args);
      return args[2];
    },
    validateResponse: validateProtocol,
  });
  const review = new ReviewService({
    decideReview: async (args) => {
      calls.decide.push(args);
      return { review_id: args.review_id, status: "approved", decision: { decision: args.decision } };
    },
    validateResponse: validateProtocol,
  });

  const ttsOutcome = await tts.execute(context(), normalizeTtsCommand({
    idempotency_key: "tts-key-001",
    text: " hello ",
    language: "en-US",
    format: "mp3",
  }));
  const reviewOutcome = await review.execute(context(), normalizeReviewCommand({
    idempotency_key: "review-key-001",
    review_id: "rev_abcd",
    decision: "approve",
    correction: { entities: { stage: { value: "Closed Won" } } },
  }));

  assert.equal(ttsOutcome.kind, "tts.created");
  assert.equal(calls.synthesize[0][0], "hello");
  assert.equal(calls.persist.length, 1);
  assert.equal(calls.record.length, 1);
  assert.equal(reviewOutcome.kind, "review.decided");
  assert.equal(calls.decide[0].review_id, "rev_abcd");
  assert.equal(calls.decide[0].correction.entities.stage.value, "Closed Won");
});

test("AskService marks provider and storage failures on the interaction", async (t) => {
  await t.test("provider failure", async () => {
    const failure = Object.assign(new Error("intent provider unavailable"), {
      code: "UPSTREAM_UNAVAILABLE",
    });
    const { service, calls } = askFixture({ understand: async () => { throw failure; } });

    await assert.rejects(service.execute(context(), textCommand()), failure);
    assert.equal(calls.failed.length, 1);
    assert.equal(calls.failed[0].error_code, "UPSTREAM_UNAVAILABLE");
  });

  await t.test("input storage failure", async () => {
    const failure = Object.assign(new Error("object upload failed"), {
      code: "UPSTREAM_UNAVAILABLE",
    });
    const { service, calls } = askFixture({
      persistInputAudio: async () => { throw failure; },
      transcribe: async () => { throw new Error("ASR must not run after storage failure"); },
    });
    const command = normalizeAskCommand({
      idempotency_key: "audio-key-001",
      input: {
        type: "audio",
        data: Buffer.from("MOCK_AUDIO:find acme"),
        content_type: "audio/wav",
      },
      locale: "zh-CN",
      output_mode: "text",
      conversation_id: "conversation-audio",
    });

    await assert.rejects(service.execute(context(), command), failure);
    assert.equal(calls.failed.length, 1);
    assert.equal(calls.failed[0].error_code, "UPSTREAM_UNAVAILABLE");
  });
});
