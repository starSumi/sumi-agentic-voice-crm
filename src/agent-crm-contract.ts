import * as Ajv2020Module from "ajv/dist/2020.js";
import { sha256 } from "./contracts.ts";
import {
  AGENT_CRM_ACTION_SCHEMA,
  AGENT_CRM_ACTION_SCHEMA_VERSION,
  AGENT_CRM_INTENT_DEFINITIONS,
  AGENT_CRM_INTENTS,
  AGENT_CRM_PROVIDER_OUTPUT_SCHEMA,
  type AgentCrmIntent,
} from "./generated/agent-crm-contract.ts";

const Ajv2020: any = (Ajv2020Module as any).default ?? Ajv2020Module;
const ajv: any = new Ajv2020({ allErrors: true, strict: true });
const validateProviderOutput: any = ajv.compile(AGENT_CRM_PROVIDER_OUTPUT_SCHEMA);
const validateAction: any = ajv.compile(AGENT_CRM_ACTION_SCHEMA);
const INTENT_SET = new Set<string>(AGENT_CRM_INTENTS);

type JsonRecord = Record<string, any>;
type IntentDefinition = (typeof AGENT_CRM_INTENT_DEFINITIONS)[AgentCrmIntent];

function invalid(message: string): Error & { code: string; breakerEligible: false } {
  return Object.assign(new Error(message), {
    code: "INVALID_REQUEST",
    breakerEligible: false as const,
  });
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (current, segment) =>
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[segment]
        : undefined,
    value,
  );
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function isAgentCrmIntent(intent: unknown): intent is AgentCrmIntent {
  return typeof intent === "string" && INTENT_SET.has(intent);
}

export function agentCrmIntentDefinition(intent: unknown): IntentDefinition {
  if (!isAgentCrmIntent(intent)) throw invalid("CRM intent is not implemented");
  return AGENT_CRM_INTENT_DEFINITIONS[intent];
}

export function assertAgentCrmProviderOutput(value: unknown): asserts value is JsonRecord {
  if (!validateProviderOutput(value)) {
    throw invalid(
      `intent provider output violates the Agent CRM contract: ${ajv.errorsText(validateProviderOutput.errors)}`,
    );
  }
  const output = value as JsonRecord;
  const definition = agentCrmIntentDefinition(output.intent);
  for (const path of definition.required_entity_paths) {
    if (!present(valueAtPath(output.entities, path)) && !output.missing.includes(path)) {
      throw invalid(`intent provider must declare absent ${path} in missing`);
    }
  }
}

export function assertExecutableAgentCrmEntities(intent: unknown, entities: unknown): void {
  const definition = agentCrmIntentDefinition(intent);
  for (const path of definition.required_entity_paths) {
    if (!present(valueAtPath(entities, path))) {
      throw invalid(`approved CRM action is missing required entity ${path}`);
    }
  }
}

export function createAgentCrmActionProposal({
  context,
  understanding,
  target,
  idempotencyKey,
  requestFingerprint,
}: {
  context: JsonRecord;
  understanding: JsonRecord;
  target: JsonRecord;
  idempotencyKey: string;
  requestFingerprint: string;
}): Readonly<JsonRecord> {
  const definition = agentCrmIntentDefinition(understanding.intent);
  const action = {
    schema_version: AGENT_CRM_ACTION_SCHEMA_VERSION,
    action_id: `act_${sha256(`${requestFingerprint}:${understanding.intent}`).slice(0, 32)}`,
    intent: understanding.intent,
    effect: definition.effect,
    subject: {
      tenant_id: context.identity?.tenant_id,
      actor_id: context.identity?.actor_id,
    },
    target: {
      resource_type: target.type,
      resource_id: target.id,
    },
    parameters: structuredClone(understanding.entities),
    evidence: [
      {
        kind: "interaction_input",
        request_id: context.request_id,
        digest: understanding.source?.transcript_hash,
        language: understanding.source?.language,
        model: understanding.source?.model,
      },
    ],
    idempotency: {
      key_digest: `sha256:${sha256(idempotencyKey)}`,
      request_fingerprint: requestFingerprint,
    },
    policy: {
      authorization_action: definition.authorization_action,
      requires_human_review: definition.review_policy === "required",
    },
  };
  if (!validateAction(action)) {
    throw invalid(`CRM action proposal violates the contract: ${ajv.errorsText(validateAction.errors)}`);
  }
  return Object.freeze(action);
}

export function assertAgentCrmActionProposal(value: unknown): asserts value is JsonRecord {
  if (!validateAction(value)) {
    throw invalid(`CRM action proposal violates the contract: ${ajv.errorsText(validateAction.errors)}`);
  }
}
