import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { testError, testErrorDetails } from "./test-types.ts";
import {
  AskService,
  normalizeAskCommand,
  normalizeReviewCommand,
  normalizeTtsCommand,
  ReviewService,
  TtsService,
} from "../src/application/index.ts";
import { createRequestContext } from "../src/composition-root.ts";
import { understanding } from "../src/contracts.ts";
import { createApp } from "../src/server.ts";
import { CrmStore } from "../src/store.ts";
import { MemoryObjectStorage } from "../src/object-storage.ts";
import { createObservability } from "../src/observability.ts";
import type {
  AuthorizationDecision,
  AuthorizationRequest as RuntimeAuthorizationRequest,
  AuthorizationReasonCode,
} from "../src/authorization/index.ts";

const REQUEST_ID = "req_authorization0123456789";
type ServiceAuthorizationRequest = {
  readonly action: string;
  readonly resource: Readonly<Record<string, unknown>> & {
    readonly id?: string;
    readonly type?: string;
  };
};

function tcpPort(address: AddressInfo | string | null): number {
  if (!address || typeof address === "string") {
    throw new TypeError("expected TCP server address");
  }
  return address.port;
}

function context() {
  return createRequestContext({
    request_id: REQUEST_ID,
    traceparent: "00-authorization-test",
    identity: {
      tenant_id: "tenant_demo",
      actor_id: "actor-a",
      principal_kind: "human",
      status: "active",
      roles: ["agent"],
      actor_scopes: ["interaction.ask", "crm.search"],
      token_scopes: ["interaction.ask", "crm.search"],
      authentication_methods: ["test_token"],
    },
  });
}

function askCommand(text = "find acme") {
  return normalizeAskCommand({
    idempotency_key: "authorization-ask-001",
    input: { type: "text", text },
    locale: "en-US",
    output_mode: "text",
  });
}

function allow(policyVersion = "test-policy"): AuthorizationDecision {
  return {
    effect: "allow",
    policy_version: policyVersion,
    reason_codes: ["ALLOW"],
    obligations: [],
  };
}

function deny(
  reason: AuthorizationReasonCode = "RBAC_DENY",
): AuthorizationDecision & { internal_debug: string } {
  return {
    effect: "deny",
    policy_version: "test-policy",
    reason_codes: [reason],
    obligations: ["audit_log"],
    internal_debug: "must not escape",
  };
}

test("application services default-deny when the authorization port is absent", async () => {
  let beginCalls = 0;
  let providerCalls = 0;
  const service = new AskService({
    beginInteraction: async () => {
      beginCalls += 1;
    },
    understand: async () => {
      providerCalls += 1;
    },
  });

  await assert.rejects(service.execute(context(), askCommand()), (error) => {
    assert.equal(testError(error).code, "FORBIDDEN");
    assert.deepEqual(testErrorDetails(error), {
      policy_version: "unknown",
      reason_codes: ["DEFAULT_DENY"],
    });
    return true;
  });
  assert.equal(beginCalls, 0);
  assert.equal(providerCalls, 0);
});

test("entry denial is normalized and occurs before store or provider effects", async () => {
  const decisions: ServiceAuthorizationRequest[] = [];
  let storeCalls = 0;
  let providerCalls = 0;
  const service = new AskService({
    authorize: async (request: ServiceAuthorizationRequest) => {
      decisions.push(request);
      return deny();
    },
    beginInteraction: async () => {
      storeCalls += 1;
    },
    understand: async () => {
      providerCalls += 1;
    },
  });

  await assert.rejects(service.execute(context(), askCommand()), (error) => {
    assert.equal(testError(error).code, "FORBIDDEN");
    assert.deepEqual(Object.keys(testErrorDetails(error)).sort(), [
      "policy_version",
      "reason_codes",
    ]);
    assert.deepEqual(testErrorDetails(error).reason_codes, ["RBAC_DENY"]);
    return true;
  });
  assert.equal(storeCalls, 0);
  assert.equal(providerCalls, 0);
  assert.deepEqual(decisions[0], {
    action: "interaction.ask",
    principal: {
      subject_id: "actor-a",
      kind: "human",
      tenant_id: "tenant_demo",
      status: "active",
      roles: ["agent"],
      actor_scopes: ["interaction.ask", "crm.search"],
    },
    resource: {
      type: "interaction",
      id: REQUEST_ID,
      tenant_id: "tenant_demo",
    },
    context: {
      token_scopes: ["interaction.ask", "crm.search"],
      request_id: REQUEST_ID,
      authentication_methods: ["test_token"],
    },
  });
});

test("AskService performs intent authorization after understanding and before CRM effects", async () => {
  const actions: ServiceAuthorizationRequest[] = [];
  const calls = {
    begin: 0,
    checkpoint: 0,
    understand: 0,
    crm: 0,
    review: 0,
    failed: 0,
  };
  const service = new AskService({
    authorize: async (request: ServiceAuthorizationRequest) => {
      actions.push(request);
      return request.action === "interaction.ask"
        ? allow()
        : deny("TOKEN_SCOPE_DENY");
    },
    beginInteraction: async () => {
      calls.begin += 1;
      return { replay: false };
    },
    checkpointInteraction: async () => {
      calls.checkpoint += 1;
    },
    completeInteraction: async () => {},
    failInteraction: async () => {
      calls.failed += 1;
    },
    understand: async () => {
      calls.understand += 1;
      return understanding({
        intent: "crm.deal.update_stage",
        confidence: 0.99,
        entities: {
          deal: { value: "deal-42" },
          stage: { value: "Negotiation" },
        },
        transcript: "move deal 42",
        language: "en",
        model: "intent-test",
      });
    },
    executeCrm: async () => {
      calls.crm += 1;
    },
    createReview: async () => {
      calls.review += 1;
    },
    now: () => 100,
  });

  await assert.rejects(
    service.execute(context(), askCommand("move deal 42")),
    (error) =>
      testError(error).code === "FORBIDDEN" &&
      testErrorDetails(error).reason_codes[0] === "TOKEN_SCOPE_DENY",
  );
  assert.deepEqual(
    actions.map(({ action }) => action),
    ["interaction.ask", "crm.deal.update_stage"],
  );
  assert.deepEqual(actions[1]?.resource, {
    type: "deal",
    id: "deal-42",
    tenant_id: "tenant_demo",
  });
  assert.equal(calls.begin, 1);
  assert.equal(calls.understand, 1);
  assert.equal(calls.checkpoint, 1);
  assert.equal(calls.crm, 0);
  assert.equal(calls.review, 0);
  assert.equal(calls.failed, 1);
});

test("TTS and review authorization precede every delegated effect", async (t) => {
  await t.test("TTS", async () => {
    let replayCalls = 0;
    let providerCalls = 0;
    const actions: ServiceAuthorizationRequest[] = [];
    const service = new TtsService({
      authorize: async (request: ServiceAuthorizationRequest) => {
        actions.push(request);
        return deny();
      },
      replayTts: async () => {
        replayCalls += 1;
      },
      synthesize: async () => {
        providerCalls += 1;
      },
    });
    await assert.rejects(
      service.execute(
        context(),
        normalizeTtsCommand({
          idempotency_key: "authorization-tts-001",
          text: "hello",
          language: "en-US",
          format: "mp3",
        }),
      ),
      (error) => testError(error).code === "FORBIDDEN",
    );
    assert.equal(actions[0]?.action, "media.tts.create");
    assert.equal(replayCalls, 0);
    assert.equal(providerCalls, 0);
  });

  await t.test("review", async () => {
    let decideCalls = 0;
    const actions: ServiceAuthorizationRequest[] = [];
    const service = new ReviewService({
      authorize: async (request: ServiceAuthorizationRequest) => {
        actions.push(request);
        return deny();
      },
      decideReview: async () => {
        decideCalls += 1;
      },
    });
    await assert.rejects(
      service.execute(
        context(),
        normalizeReviewCommand({
          idempotency_key: "authorization-review-001",
          review_id: "rev_authorization",
          decision: "approve",
        }),
      ),
      (error) => testError(error).code === "FORBIDDEN",
    );
    assert.equal(actions[0]?.action, "review.decide");
    assert.equal(actions[0]?.resource.id, "rev_authorization");
    assert.equal(decideCalls, 0);
  });
});

test("events and asset routes authorize before reading tenant data", async (t) => {
  const actions: RuntimeAuthorizationRequest[] = [];
  const reads = { events: 0, asset: 0 };
  const store = new CrmStore();
  store.events = () => {
    reads.events += 1;
    return [];
  };
  store.assetFor = () => {
    reads.asset += 1;
    return undefined;
  };
  const runtime = {
    env: {},
    authenticate: async () => context().identity,
    authorize: async (request: RuntimeAuthorizationRequest) => {
      actions.push(request);
      return deny();
    },
    store,
    providers: {
      providerReadiness: () => ({
        ready: true,
        names: { asr: "test", intent: "test", tts: "test" },
        statuses: {
          asr: { provider: "test", ready: true, circuit: "closed" },
          intent: { provider: "test", ready: true, circuit: "closed" },
          tts: { provider: "test", ready: true, circuit: "closed" },
        },
      }),
      transcribe: async () => ({
        text: "test",
        language: "en",
        confidence: 1,
        provider: "test",
        model: "test",
        duration_ms: 0,
      }),
      understand: async () => ({
        intent: "crm.search",
        confidence: 1,
        entities: {},
        missing: [],
        needs_confirmation: false,
        schema_version: "sumi.agent-crm-understanding.v1",
        source: {
          transcript_hash: `sha256:${"0".repeat(64)}`,
          language: "en",
          model: "test",
        },
      }),
      synthesize: async () => ({
        asset_id: "ast_test",
        url: "/v1/assets/ast_test",
        mime_type: "audio/mpeg",
        duration_ms: 0,
        expires_at: "2030-01-01T00:00:00.000Z",
        voice: "test",
        provider: "test",
        model: "test",
        status: "ready",
        data_base64: "",
      }),
      ttsDefaultFormat: () => "mp3",
    },
    objectStorage: new MemoryObjectStorage(),
    observability: createObservability({ write: () => {} }),
    close: async () => {},
  };
  const app = createApp({ runtime });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${tcpPort(app.server.address())}`;

  const eventsResponse = await fetch(`${origin}/v1/events`);
  const assetResponse = await fetch(`${origin}/v1/assets/ast_12345678`);
  assert.equal(eventsResponse.status, 403);
  assert.equal(assetResponse.status, 403);
  assert.deepEqual(
    actions.map(({ action }) => action),
    ["events.read", "media.asset.read"],
  );
  assert.deepEqual(
    actions.map(({ resource }) => resource.type),
    ["event_stream", "media_asset"],
  );
  assert.deepEqual(reads, { events: 0, asset: 0 });
});
