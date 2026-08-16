import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import protocol from "../protocol/schema/json/openapi.bundle.json" with { type: "json" };
import events from "../protocol/schema/json/events.bundle.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(protocol, "sumi-openapi");
ajv.addSchema(events, "sumi-events");

const validators = Object.freeze({
  AttachmentRef: ajv.getSchema("sumi-openapi#/components/schemas/AttachmentRef"),
  AskRequest: ajv.getSchema("sumi-openapi#/components/schemas/AskRequest"),
  AskResponse: ajv.getSchema("sumi-openapi#/components/schemas/AskResponse"),
  ReviewResponse: ajv.getSchema("sumi-openapi#/components/schemas/ReviewResponse"),
  ReviewDecisionRequest: ajv.getSchema("sumi-openapi#/components/schemas/ReviewDecisionRequest"),
  ReviewDecisionResponse: ajv.getSchema("sumi-openapi#/components/schemas/ReviewDecisionResponse"),
  ReviewId: ajv.getSchema("sumi-openapi#/components/schemas/ReviewId"),
  MultipartAskMetadata: ajv.getSchema("sumi-openapi#/components/schemas/MultipartAskMetadata"),
  TtsRequest: ajv.getSchema("sumi-openapi#/components/schemas/TtsRequest"),
  TtsSynthesizeResponse: ajv.getSchema("sumi-openapi#/components/schemas/TtsSynthesizeResponse"),
  ErrorEnvelope: ajv.getSchema("sumi-openapi#/components/schemas/ErrorEnvelope"),
  EventEnvelope: ajv.getSchema("sumi-events"),
});

function invalidRequest(message, errors) {
  return Object.assign(new Error(message), {
    code: "INVALID_REQUEST",
    details: { validation_errors: errors ?? [] },
  });
}

export function validateProtocol(name, value) {
  const validator = validators[name];
  if (!validator) throw new Error(`unknown protocol schema: ${name}`);
  if (!validator(value)) {
    throw invalidRequest(
      `${name} violates the published protocol`,
      validator.errors?.map(({ instancePath, keyword, message }) => ({
        path: instancePath,
        keyword,
        message,
      })),
    );
  }
  return value;
}

export function validateEvent(value) {
  const validator = validators.EventEnvelope;
  if (!validator(value)) {
    throw invalidRequest(
      "event violates the published protocol",
      validator.errors?.map(({ instancePath, keyword, message }) => ({
        path: instancePath,
        keyword,
        message,
      })),
    );
  }
  return value;
}
