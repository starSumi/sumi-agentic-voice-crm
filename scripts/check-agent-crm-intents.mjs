import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { loadAgentCrmContract } from "./generate-agent-crm-contract.mjs";

const { registry } = await loadAgentCrmContract();
const [openapi, authorization] = await Promise.all([
  readFile("contracts/openapi.yaml", "utf8").then(parse),
  readFile("contracts/authorization-policy.json", "utf8").then(JSON.parse),
]);

const registryIntents = registry.intents.map(({ id }) => id);
const openapiIntents = openapi.components?.schemas?.AgentCrmIntent?.enum;
if (JSON.stringify(openapiIntents) !== JSON.stringify(registryIntents)) {
  throw new Error("OpenAPI AgentCrmIntent enum must exactly match the intent registry");
}
const understanding = openapi.components?.schemas?.Understanding;
if (understanding?.properties?.schema_version?.const !== registry.intent_schema_version) {
  throw new Error("OpenAPI understanding schema version must match the intent registry");
}
for (const field of ["intent", "confidence", "entities", "missing", "needs_confirmation", "schema_version", "source"]) {
  if (!understanding?.required?.includes(field))
    throw new Error(`OpenAPI Understanding must require ${field}`);
}
for (const field of ["transcript_hash", "language", "model"]) {
  if (!understanding?.properties?.source?.required?.includes(field))
    throw new Error(`OpenAPI Understanding.source must require ${field}`);
}

for (const definition of registry.intents) {
  if (!authorization.actions.includes(definition.authorization_action))
    throw new Error(`${definition.id} is missing from the authorization action registry`);
  const policyResources = authorization.action_resources[definition.authorization_action];
  if (JSON.stringify(policyResources) !== JSON.stringify(definition.resource_types))
    throw new Error(`${definition.id} authorization resources do not match the intent registry`);
  const obligations = authorization.allow_obligations[definition.authorization_action] ?? [];
  if (definition.effect === "write") {
    for (const obligation of ["idempotency_key", "human_review", "outbox_write"]) {
      if (!obligations.includes(obligation))
        throw new Error(`${definition.id} must enforce ${obligation}`);
    }
  } else if (obligations.includes("human_review")) {
    throw new Error(`${definition.id} read effects cannot require unconditional human review`);
  }
}

const crmAuthorizationActions = authorization.actions.filter((action) => action.startsWith("crm."));
if (JSON.stringify(crmAuthorizationActions) !== JSON.stringify(registryIntents)) {
  throw new Error("authorization policy contains a CRM action that is not an implemented intent");
}

console.log(`agent CRM intent contract passed: ${registryIntents.join(", ")}`);
