import assert from "node:assert/strict";
import test from "node:test";
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

const REQUEST_ID = "req_authorization0123456789";

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

function allow(policyVersion = "test-policy") {
  return {
    effect: "allow",
    policy_version: policyVersion,
    reason_codes: ["ALLOW"],
    obligations: [],
  };
}

function deny(reason = "RBAC_DENY") {
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
    assert.equal(error.code, "FORBIDDEN");
    assert.deepEqual(error.details, {
      policy_version: "unknown",
      reason_codes: ["DEFAULT_DENY"],
    });
    return true;
  });
  assert.equal(beginCalls, 0);
  assert.equal(providerCalls, 0);
});

test("entry denial is normalized and occurs before store or provider effects", async () => {
  const decisions = [];
  let storeCalls = 0;
  let providerCalls = 0;
  const service = new AskService({
    authorize: async (request) => {
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
    assert.equal(error.code, "FORBIDDEN");
    assert.deepEqual(Object.keys(error.details).sort(), [
      "policy_version",
      "reason_codes",
    ]);
    assert.deepEqual(error.details.reason_codes, ["RBAC_DENY"]);
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
  const actions = [];
  const calls = {
    begin: 0,
    checkpoint: 0,
    understand: 0,
    crm: 0,
    review: 0,
    failed: 0,
  };
  const service = new AskService({
    authorize: async (request) => {
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
      error.code === "FORBIDDEN" &&
      error.details.reason_codes[0] === "TOKEN_SCOPE_DENY",
  );
  assert.deepEqual(
    actions.map(({ action }) => action),
    ["interaction.ask", "crm.deal.update_stage"],
  );
  assert.deepEqual(actions[1].resource, {
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
    const actions = [];
    const service = new TtsService({
      authorize: async (request) => {
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
      (error) => error.code === "FORBIDDEN",
    );
    assert.equal(actions[0].action, "media.tts.create");
    assert.equal(replayCalls, 0);
    assert.equal(providerCalls, 0);
  });

  await t.test("review", async () => {
    let decideCalls = 0;
    const actions = [];
    const service = new ReviewService({
      authorize: async (request) => {
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
      (error) => error.code === "FORBIDDEN",
    );
    assert.equal(actions[0].action, "review.decide");
    assert.equal(actions[0].resource.id, "rev_authorization");
    assert.equal(decideCalls, 0);
  });
});

test("events and asset routes authorize before reading tenant data", async (t) => {
  const actions = [];
  const reads = { events: 0, asset: 0 };
  const runtime = {
    env: {},
    authenticate: async () => context().identity,
    authorize: async (request) => {
      actions.push(request);
      return deny();
    },
    store: {
      health: async () => ({ ready: true }),
      events: async () => {
        reads.events += 1;
        return [];
      },
      assetFor: async () => {
        reads.asset += 1;
        return undefined;
      },
    },
    providers: {
      providerReadiness: () => ({ ready: true, statuses: {} }),
    },
    objectStorage: {
      health: async () => ({ ready: true }),
    },
    observability: {
      begin: () => ({ traceparent: "00-route-authorization" }),
      finish: () => {},
      authorizeMetrics: () => false,
      renderMetrics: () => "",
    },
    close: async () => {},
  };
  const app = createApp({ runtime });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;

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
