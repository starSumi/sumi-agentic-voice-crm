import { createRequire } from "node:module";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import protocol from "../protocol/schema/json/openapi.bundle.json" with { type: "json" };
import events from "../protocol/schema/json/events.bundle.json" with { type: "json" };

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(protocol, "sumi-openapi");
ajv.addSchema(events, "sumi-events");

function schemaValidator(reference: string): ValidateFunction<unknown> {
  const validator = ajv.getSchema(reference);
  if (!validator) throw new Error(`unknown protocol schema: ${reference}`);
  return validator;
}

const validators = Object.freeze({
  AttachmentRef: schemaValidator(
    "sumi-openapi#/components/schemas/AttachmentRef",
  ),
  AskRequest: schemaValidator("sumi-openapi#/components/schemas/AskRequest"),
  AskResponse: schemaValidator("sumi-openapi#/components/schemas/AskResponse"),
  MessageJobResponse: schemaValidator(
    "sumi-openapi#/components/schemas/MessageJobResponse",
  ),
  MessageJobStatsResponse: schemaValidator(
    "sumi-openapi#/components/schemas/MessageJobStatsResponse",
  ),
  ReviewResponse: schemaValidator(
    "sumi-openapi#/components/schemas/ReviewResponse",
  ),
  ReviewDecisionRequest: schemaValidator(
    "sumi-openapi#/components/schemas/ReviewDecisionRequest",
  ),
  ReviewDecisionResponse: schemaValidator(
    "sumi-openapi#/components/schemas/ReviewDecisionResponse",
  ),
  ReviewId: schemaValidator("sumi-openapi#/components/schemas/ReviewId"),
  MultipartAskMetadata: schemaValidator(
    "sumi-openapi#/components/schemas/MultipartAskMetadata",
  ),
  TtsRequest: schemaValidator("sumi-openapi#/components/schemas/TtsRequest"),
  TtsSynthesizeResponse: schemaValidator(
    "sumi-openapi#/components/schemas/TtsSynthesizeResponse",
  ),
  ErrorEnvelope: schemaValidator(
    "sumi-openapi#/components/schemas/ErrorEnvelope",
  ),
  EventEnvelope: schemaValidator("sumi-events"),
});

function invalidRequest(message: string, errors?: readonly unknown[]) {
  return Object.assign(new Error(message), {
    code: "INVALID_REQUEST",
    details: { validation_errors: errors ?? [] },
  });
}

function validationErrors(
  errors: ErrorObject[] | null | undefined,
): ReadonlyArray<{
  path: string;
  keyword: string;
  message: string | undefined;
}> {
  return (errors ?? []).map(({ instancePath, keyword, message }) => ({
    path: instancePath,
    keyword,
    message,
  }));
}

export function validateProtocol<T>(
  name: keyof typeof validators,
  value: T,
): T {
  const validator = validators[name];
  if (!validator(value)) {
    throw invalidRequest(
      `${name} violates the published protocol`,
      validationErrors(validator.errors),
    );
  }
  return value;
}

export function validateEvent<T>(value: T): T {
  const validator = validators.EventEnvelope;
  if (!validator(value)) {
    throw invalidRequest(
      "event violates the published protocol",
      validationErrors(validator.errors),
    );
  }
  return value;
}
