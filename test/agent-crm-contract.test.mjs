import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCrmIntentDefinition,
  assertAgentCrmActionProposal,
  assertAgentCrmProviderOutput,
  assertExecutableAgentCrmEntities,
  createAgentCrmActionProposal,
} from "../src/agent-crm-contract.ts";
import { AGENT_CRM_INTENTS } from "../src/generated/agent-crm-contract.ts";
import { CrmStore } from "../src/store.ts";

const requestContext = Object.freeze({
  request_id: "req_0123456789abcdef01234567",
  identity: Object.freeze({ tenant_id: "tenant_demo", actor_id: "actor_demo" }),
});

function understanding(overrides = {}) {
  return {
    intent: "crm.search",
    confidence: 0.95,
    entities: { query: { value: "Acme" } },
    missing: [],
    needs_confirmation: false,
    schema_version: "sumi.agent-crm-understanding.v1",
    source: {
      transcript_hash: `sha256:${"a".repeat(64)}`,
      language: "zh",
      model: "intent-model",
    },
    ...overrides,
  };
}

test("intent registry exposes only implemented CRM labels", () => {
  assert.deepEqual([...AGENT_CRM_INTENTS], [
    "crm.search",
    "crm.customer.create",
    "crm.deal.update_stage",
  ]);
  assert.equal(agentCrmIntentDefinition("crm.search").effect, "read");
  assert.equal(agentCrmIntentDefinition("crm.customer.create").review_policy, "required");
  assert.throws(() => agentCrmIntentDefinition("crm.future"), (error) => error.code === "INVALID_REQUEST");
});

test("provider output is intent-specific and fail-closed", () => {
  assert.doesNotThrow(() =>
    assertAgentCrmProviderOutput({
      intent: "crm.search",
      confidence: 0.95,
      entities: { query: { value: "Acme" } },
      missing: [],
      needs_confirmation: false,
    }),
  );
  assert.doesNotThrow(() =>
    assertAgentCrmProviderOutput({
      intent: "crm.customer.create",
      confidence: 0.9,
      entities: {},
      missing: ["customer.name"],
      needs_confirmation: true,
    }),
  );
  assert.throws(
    () =>
      assertAgentCrmProviderOutput({
        intent: "crm.customer.create",
        confidence: 0.9,
        entities: { customer: { name: "Ada" }, unsupported: true },
        missing: [],
        needs_confirmation: true,
      }),
    (error) => error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () =>
      assertAgentCrmProviderOutput({
        intent: "crm.deal.update_stage",
        confidence: 0.9,
        entities: {},
        missing: [],
        needs_confirmation: false,
      }),
    (error) => error.code === "INVALID_REQUEST",
  );
});

test("business action binds evidence and idempotency without raw input", () => {
  const output = understanding();
  const action = createAgentCrmActionProposal({
    context: requestContext,
    understanding: output,
    target: { type: "customer", id: "Acme" },
    idempotencyKey: "intent-contract-0001",
    requestFingerprint: "b".repeat(64),
  });
  assert.doesNotThrow(() => assertAgentCrmActionProposal(action));
  assert.equal(action.intent, "crm.search");
  assert.equal(action.evidence[0].digest, output.source.transcript_hash);
  assert.equal(action.idempotency.request_fingerprint, "b".repeat(64));
  assert.doesNotMatch(JSON.stringify(action), /intent-contract-0001/);
});

test("mutation execution requires complete entities and unknown storage intents fail", () => {
  assert.throws(
    () => assertExecutableAgentCrmEntities("crm.customer.create", {}),
    (error) => error.code === "INVALID_REQUEST",
  );
  assert.doesNotThrow(() =>
    assertExecutableAgentCrmEntities("crm.deal.update_stage", {
      deal: { value: "d1" },
      stage: { value: "Negotiation" },
    }),
  );
  assert.throws(
    () =>
      new CrmStore().execute({
        tenant_id: "tenant_demo",
        actor_id: "actor_demo",
        idempotency_key: "unknown-intent-0001",
        intent: "crm.future",
        entities: {},
        request_id: requestContext.request_id,
      }),
    (error) => error.code === "INVALID_REQUEST",
  );
});
