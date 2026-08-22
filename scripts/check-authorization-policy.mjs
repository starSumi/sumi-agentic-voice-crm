import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

const ACTIONS = [
  "interaction.ask",
  "crm.search",
  "crm.customer.create",
  "crm.deal.update_stage",
  "review.decide",
  "media.tts.create",
  "media.asset.read",
  "events.read",
  "progress.subscribe",
  "outbox.relay",
];
const ROLES = ["agent", "reviewer", "auditor", "tenant_admin", "workload"];
const CONDITIONS = [
  "tenant_match",
  "resource_type_allowed",
  "active_principal",
  "human_principal",
  "mfa_present",
  "workload_principal",
  "trusted_network",
];
const OPERATION_ACTIONS = {
  ask: "interaction.ask",
  synthesize: "media.tts.create",
  decideReview: "review.decide",
  getAsset: "media.asset.read",
  getAssetContent: "media.asset.read",
  listEvents: "events.read",
  listMessageJobStats: "interaction.ask",
  getMessageJob: "interaction.ask",
};

function grantMatches(grant, action, allowedWildcards) {
  return (
    grant === action ||
    (allowedWildcards.has(grant) &&
      grant.endsWith(".*") &&
      action.startsWith(grant.slice(0, -1)))
  );
}

export async function checkAuthorizationPolicy() {
  const [schema, policy, openapi, events] = await Promise.all([
    readFile("contracts/authorization-policy.schema.json", "utf8").then(
      JSON.parse,
    ),
    readFile("contracts/authorization-policy.json", "utf8").then(JSON.parse),
    readFile("contracts/openapi.yaml", "utf8").then(parse),
    readFile("contracts/events.yaml", "utf8").then(parse),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(policy)) {
    throw new Error(
      `authorization policy schema failed: ${ajv.errorsText(validate.errors)}`,
    );
  }

  assert.equal(policy.default_effect, "deny");
  assert.deepEqual(policy.roles, ROLES);
  assert.deepEqual(policy.actions, ACTIONS);
  assert.deepEqual(policy.conditions, CONDITIONS);
  assert.deepEqual(Object.keys(policy.role_actions), ROLES);
  assert.deepEqual(Object.keys(policy.action_resources), ACTIONS);
  assert.deepEqual(Object.keys(policy.action_conditions), ACTIONS);
  assert.deepEqual(Object.keys(policy.allow_obligations), ACTIONS);

  const actionSet = new Set(ACTIONS);
  const conditionSet = new Set(CONDITIONS);
  const wildcards = new Set(policy.allowed_action_wildcards);
  for (const wildcard of wildcards) {
    assert.match(wildcard, /^[a-z][a-z0-9_-]*\.\*$/);
    assert.notEqual(wildcard, "*");
    assert.ok(
      ACTIONS.some((action) => grantMatches(wildcard, action, wildcards)),
      `${wildcard} must cover a known action`,
    );
  }

  for (const [role, grants] of Object.entries(policy.role_actions)) {
    for (const grant of grants) {
      assert.ok(
        actionSet.has(grant) || wildcards.has(grant),
        `${role} contains undeclared grant ${grant}`,
      );
    }
  }
  for (const action of ACTIONS) {
    const conditions = policy.action_conditions[action];
    assert.ok(
      conditions.includes("tenant_match"),
      `${action} must enforce tenant_match`,
    );
    assert.ok(
      conditions.includes("resource_type_allowed"),
      `${action} must enforce resource_type_allowed`,
    );
    assert.ok(
      conditions.includes("active_principal"),
      `${action} must enforce active_principal`,
    );
    assert.ok(
      conditions.every((condition) => conditionSet.has(condition)),
      `${action} contains an unknown condition`,
    );
    assert.ok(
      policy.allow_obligations[action].includes("tenant_filter"),
      `${action} must retain tenant_filter obligation`,
    );
    assert.ok(
      ROLES.some((role) =>
        policy.role_actions[role].some((grant) =>
          grantMatches(grant, action, wildcards),
        ),
      ),
      `${action} is unreachable`,
    );
  }

  for (const action of [
    "crm.customer.create",
    "crm.deal.update_stage",
    "review.decide",
  ]) {
    assert.ok(policy.action_conditions[action].includes("human_principal"));
  }
  for (const role of ["agent", "reviewer"]) {
    assert.ok(policy.role_actions[role].includes("crm.customer.create"));
    assert.ok(policy.role_actions[role].includes("crm.deal.update_stage"));
  }
  assert.deepEqual(policy.role_actions.workload, ["outbox.relay"]);
  assert.ok(
    policy.action_conditions["outbox.relay"].includes("workload_principal"),
  );
  assert.ok(
    policy.action_conditions["outbox.relay"].includes("trusted_network"),
  );
  assert.ok(
    policy.role_actions.workload.some((grant) =>
      grantMatches(grant, "outbox.relay", wildcards),
    ),
  );
  for (const role of ROLES.filter((candidate) => candidate !== "workload")) {
    assert.equal(
      policy.role_actions[role].some((grant) =>
        grantMatches(grant, "outbox.relay", wildcards),
      ),
      false,
    );
  }
  assert.deepEqual(policy.deny_obligations, ["audit_log"]);

  const operations = Object.values(openapi.paths).flatMap((pathItem) =>
    Object.values(pathItem).filter(
      (operation) =>
        operation && typeof operation === "object" && operation.operationId,
    ),
  );
  assert.deepEqual(
    Object.fromEntries(
      operations.map((operation) => [
        operation.operationId,
        operation["x-sumi-action"],
      ]),
    ),
    OPERATION_ACTIONS,
  );
  for (const action of Object.values(OPERATION_ACTIONS)) {
    assert.ok(
      actionSet.has(action),
      `OpenAPI operation contains unknown action ${action}`,
    );
  }

  const projection = openapi.components.schemas.EventStreamEnvelope;
  assert.deepEqual(projection.required, events.required);
  assert.deepEqual(
    Object.keys(projection.properties),
    Object.keys(events.properties),
  );
  assert.deepEqual(
    projection.properties.type.enum,
    events.properties.type.enum,
  );
  return policy;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const policy = await checkAuthorizationPolicy();
  console.log(
    `authorization policy passed: ${policy.roles.length} roles, ${policy.actions.length} actions, ${policy.conditions.length} named conditions`,
  );
}
