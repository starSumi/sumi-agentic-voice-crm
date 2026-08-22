import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { format } from "prettier";

const SOURCE_REGISTRY = "contracts/agent-crm-intents.json";
const SOURCE_SCHEMA = "contracts/agent-crm-intents.schema.json";

function providerOutputVariant(definition) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "intent",
      "confidence",
      "entities",
      "missing",
      "needs_confirmation",
    ],
    properties: {
      intent: { const: definition.id },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      entities: definition.entity_schema,
      missing: {
        type: "array",
        uniqueItems: true,
        items: { enum: definition.allowed_missing_paths },
      },
      needs_confirmation:
        definition.review_policy === "required"
          ? { const: true }
          : { type: "boolean" },
    },
  };
}

function createProviderOutputSchema(registry) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://protocol.sumi.invalid/agent-crm/provider-output/v1/schema.json",
    oneOf: registry.intents.map(providerOutputVariant),
  };
}

function createProviderRequestSchema(registry) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "intent",
      "confidence",
      "entities",
      "missing",
      "needs_confirmation",
    ],
    properties: {
      intent: { enum: registry.intents.map(({ id }) => id) },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      entities: { type: "object" },
      missing: {
        type: "array",
        uniqueItems: true,
        items: {
          enum: [
            ...new Set(
              registry.intents.flatMap(({ allowed_missing_paths }) =>
                allowed_missing_paths,
              ),
            ),
          ],
        },
      },
      needs_confirmation: { type: "boolean" },
    },
  };
}

function createTrainingExampleSchema(registry, providerOutputSchema) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://protocol.sumi.invalid/agent-crm/training-example/v1/schema.json",
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version",
      "example_id",
      "group_id",
      "split",
      "locale",
      "input",
      "expected",
    ],
    properties: {
      schema_version: { const: registry.training_example_schema_version },
      example_id: {
        type: "string",
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      },
      group_id: {
        type: "string",
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      },
      split: { enum: ["train", "validation", "test"] },
      locale: { enum: ["zh-CN", "en-US", "hi-IN", "te-IN"] },
      input: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 10_000 },
        },
      },
      expected: { oneOf: providerOutputSchema.oneOf },
    },
  };
}

function createActionSchema(registry) {
  const intentIds = registry.intents.map(({ id }) => id);
  const resourceTypes = [
    ...new Set(registry.intents.flatMap(({ resource_types }) => resource_types)),
  ];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://protocol.sumi.invalid/agent-crm/action/v1/schema.json",
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version",
      "action_id",
      "intent",
      "effect",
      "subject",
      "target",
      "parameters",
      "evidence",
      "idempotency",
      "policy",
    ],
    properties: {
      schema_version: { const: registry.action_schema_version },
      action_id: { type: "string", pattern: "^act_[0-9a-f]{32}$" },
      intent: { enum: intentIds },
      effect: { enum: ["read", "write"] },
      subject: {
        type: "object",
        additionalProperties: false,
        required: ["tenant_id", "actor_id"],
        properties: {
          tenant_id: { type: "string", minLength: 1, maxLength: 128 },
          actor_id: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
      target: {
        type: "object",
        additionalProperties: false,
        required: ["resource_type", "resource_id"],
        properties: {
          resource_type: { enum: resourceTypes },
          resource_id: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
      parameters: { type: "object" },
      evidence: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "request_id", "digest", "language", "model"],
          properties: {
            kind: { const: "interaction_input" },
            request_id: {
              type: "string",
              pattern: "^req_[A-Za-z0-9._:-]{1,127}$",
            },
            digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
            language: { type: "string", minLength: 1, maxLength: 16 },
            model: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
      idempotency: {
        type: "object",
        additionalProperties: false,
        required: ["key_digest", "request_fingerprint"],
        properties: {
          key_digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
          request_fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      },
      policy: {
        type: "object",
        additionalProperties: false,
        required: ["authorization_action", "requires_human_review"],
        properties: {
          authorization_action: { enum: intentIds },
          requires_human_review: { type: "boolean" },
        },
      },
    },
    allOf: registry.intents.map((definition) => ({
      if: {
        type: "object",
        properties: { intent: { const: definition.id } },
        required: ["intent"],
      },
      // oxlint-disable-next-line unicorn/no-thenable
      then: {
        type: "object",
        properties: {
          effect: { const: definition.effect },
          target: {
            type: "object",
            properties: {
              resource_type: { enum: definition.resource_types },
            },
          },
          parameters: definition.entity_schema,
          policy: {
            type: "object",
            properties: {
              authorization_action: { const: definition.authorization_action },
              requires_human_review: {
                const: definition.review_policy === "required",
              },
            },
          },
        },
      },
    })),
  };
}

function validateRegistrySemantics(registry) {
  const ids = new Set();
  const handlers = new Set();
  for (const definition of registry.intents) {
    if (ids.has(definition.id)) throw new Error(`duplicate CRM intent: ${definition.id}`);
    if (handlers.has(definition.handler))
      throw new Error(`duplicate CRM intent handler: ${definition.handler}`);
    ids.add(definition.id);
    handlers.add(definition.handler);
    if (definition.authorization_action !== definition.id)
      throw new Error(`${definition.id} must use the same authorization action`);
    if (definition.effect === "write" && definition.review_policy !== "required")
      throw new Error(`${definition.id} write effects must require review`);
    if (definition.effect === "read" && definition.review_policy !== "provider_or_policy")
      throw new Error(`${definition.id} read effects must retain provider/policy review`);
    for (const path of definition.required_entity_paths) {
      if (!definition.allowed_missing_paths.includes(path))
        throw new Error(`${definition.id} required path ${path} must be an allowed missing path`);
    }
    if (
      definition.required_evidence.length !== 2 ||
      !definition.required_evidence.includes("input_digest") ||
      !definition.required_evidence.includes("request_fingerprint")
    ) {
      throw new Error(`${definition.id} must bind input and request evidence`);
    }
  }
}

export async function loadAgentCrmContract({ repositoryRoot = process.cwd() } = {}) {
  const [registry, registrySchema] = await Promise.all([
    readFile(resolve(repositoryRoot, SOURCE_REGISTRY), "utf8").then(JSON.parse),
    readFile(resolve(repositoryRoot, SOURCE_SCHEMA), "utf8").then(JSON.parse),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateRegistry = ajv.compile(registrySchema);
  if (!validateRegistry(registry)) {
    throw new Error(`agent CRM intent registry is invalid: ${JSON.stringify(validateRegistry.errors)}`);
  }
  validateRegistrySemantics(registry);
  for (const definition of registry.intents) ajv.compile(definition.entity_schema);
  const providerOutputSchema = createProviderOutputSchema(registry);
  const providerRequestSchema = createProviderRequestSchema(registry);
  const trainingExampleSchema = createTrainingExampleSchema(registry, providerOutputSchema);
  const actionSchema = createActionSchema(registry);
  ajv.compile(providerOutputSchema);
  ajv.compile(providerRequestSchema);
  ajv.compile(trainingExampleSchema);
  ajv.compile(actionSchema);
  return {
    registry,
    providerOutputSchema,
    providerRequestSchema,
    trainingExampleSchema,
    actionSchema,
  };
}

export async function generateAgentCrmContract({ outputRoot = ".", repositoryRoot = process.cwd() } = {}) {
  const contract = await loadAgentCrmContract({ repositoryRoot });
  const schemaDirectory = join(outputRoot, "protocol/schema/json");
  const generatedDirectory = join(outputRoot, "src/generated");
  await Promise.all([
    mkdir(schemaDirectory, { recursive: true }),
    mkdir(generatedDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(schemaDirectory, "agent-crm-provider-output.schema.json"),
      `${JSON.stringify(contract.providerOutputSchema, null, 2)}\n`,
    ),
    writeFile(
      join(schemaDirectory, "agent-crm-training-example.schema.json"),
      `${JSON.stringify(contract.trainingExampleSchema, null, 2)}\n`,
    ),
    writeFile(
      join(schemaDirectory, "agent-crm-action.schema.json"),
      `${JSON.stringify(contract.actionSchema, null, 2)}\n`,
    ),
  ]);

  const definitions = Object.fromEntries(
    contract.registry.intents.map((definition) => [definition.id, definition]),
  );
  const source = await format(
      `// This file is auto-generated by scripts/generate-agent-crm-contract.mjs.\n/* oxlint-disable unicorn/no-thenable */\n\n` +
      `export const AGENT_CRM_INTENT_REGISTRY = ${JSON.stringify(contract.registry)} as const;\n` +
      `export const AGENT_CRM_INTENT_DEFINITIONS = ${JSON.stringify(definitions)} as const;\n` +
      `export const AGENT_CRM_INTENTS = ${JSON.stringify(contract.registry.intents.map(({ id }) => id))} as const;\n` +
      `export type AgentCrmIntent = (typeof AGENT_CRM_INTENTS)[number];\n` +
      `export type AgentCrmIntentDefinition = (typeof AGENT_CRM_INTENT_DEFINITIONS)[AgentCrmIntent];\n` +
      `export const AGENT_CRM_INTENT_SCHEMA_VERSION = ${JSON.stringify(contract.registry.intent_schema_version)} as const;\n` +
      `export const AGENT_CRM_ACTION_SCHEMA_VERSION = ${JSON.stringify(contract.registry.action_schema_version)} as const;\n` +
      `export const AGENT_CRM_TRAINING_EXAMPLE_SCHEMA_VERSION = ${JSON.stringify(contract.registry.training_example_schema_version)} as const;\n` +
      `export const AGENT_CRM_PROVIDER_OUTPUT_SCHEMA = ${JSON.stringify(contract.providerOutputSchema)} as const;\n` +
      `export const AGENT_CRM_PROVIDER_REQUEST_SCHEMA = ${JSON.stringify(contract.providerRequestSchema)} as const;\n` +
      `export const AGENT_CRM_ACTION_SCHEMA = ${JSON.stringify(contract.actionSchema)} as const;\n`,
    { parser: "typescript" },
  );
  await writeFile(join(generatedDirectory, "agent-crm-contract.ts"), source);
  return contract;
}
