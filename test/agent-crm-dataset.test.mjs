import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentCrmDataset } from "../scripts/validate-agent-crm-dataset.mjs";

const version = "sumi.agent-crm-training-example.v1";
const example = (example_id, group_id, split, expected) =>
  JSON.stringify({
    schema_version: version,
    example_id,
    group_id,
    split,
    locale: "zh-CN",
    input: { text: `input for ${example_id}` },
    expected,
  });

const search = {
  intent: "crm.search",
  confidence: 0.99,
  entities: { query: { value: "Acme" } },
  missing: [],
  needs_confirmation: false,
};
const customer = {
  intent: "crm.customer.create",
  confidence: 0.95,
  entities: { customer: { name: "Ada" } },
  missing: [],
  needs_confirmation: true,
};
const deal = {
  intent: "crm.deal.update_stage",
  confidence: 0.9,
  entities: { deal: { value: "d1" }, stage: { value: "Negotiation" } },
  missing: [],
  needs_confirmation: true,
};

test("dataset validator covers the implemented intent set", async () => {
  const dataset = [
    example("search-1", "conversation-1", "train", search),
    example("customer-1", "conversation-2", "validation", customer),
    example("deal-1", "conversation-3", "test", deal),
  ].join("\n");
  assert.deepEqual(await validateAgentCrmDataset(dataset), {
    examples: 3,
    intents: ["crm.customer.create", "crm.deal.update_stage", "crm.search"],
  });
});

test("dataset validator rejects split leakage and incomplete annotations", async () => {
  const leaking = [
    example("search-1", "conversation-1", "train", search),
    example("search-2", "conversation-1", "test", search),
  ].join("\n");
  await assert.rejects(
    validateAgentCrmDataset(leaking, { requireAllIntents: false }),
    /crosses dataset splits/,
  );

  const incomplete = example("deal-2", "conversation-4", "train", {
    ...deal,
    entities: { stage: { value: "Won" } },
    missing: [],
  });
  await assert.rejects(
    validateAgentCrmDataset(incomplete, { requireAllIntents: false }),
    /absent deal\.value must be declared in missing/,
  );
});

test("dataset validator rejects unsupported labels and unsafe mutation flags", async () => {
  const unsupported = example("future-1", "conversation-5", "train", {
    ...search,
    intent: "crm.customer.delete",
  });
  await assert.rejects(
    validateAgentCrmDataset(unsupported, { requireAllIntents: false }),
    /schema/,
  );
  const unsafe = example("customer-2", "conversation-6", "train", {
    ...customer,
    needs_confirmation: false,
  });
  await assert.rejects(
    validateAgentCrmDataset(unsafe, { requireAllIntents: false }),
    /schema/,
  );
});
