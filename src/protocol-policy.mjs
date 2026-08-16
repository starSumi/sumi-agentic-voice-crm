import openapi from "../protocol/schema/json/openapi.bundle.json" with { type: "json" };

const schemas = openapi.components?.schemas ?? {};

function enumValues(schemaName, propertyName) {
  const values = propertyName === undefined
    ? schemas[schemaName]?.enum
    : schemas[schemaName]?.properties?.[propertyName]?.enum;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`protocol schema ${schemaName}.${propertyName} must expose a non-empty enum`);
  }
  return Object.freeze([...values]);
}

function schemaLimit(schemaName, propertyName, limitName) {
  const value = schemas[schemaName]?.properties?.[propertyName]?.[limitName];
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`protocol schema ${schemaName}.${propertyName} must expose a positive ${limitName}`);
  }
  return value;
}

const errorPolicy = openapi["x-sumi-error-policy"];
if (!errorPolicy || typeof errorPolicy !== "object") {
  throw new Error("OpenAPI x-sumi-error-policy is required");
}

export const ERROR_CODES = Object.freeze(Object.fromEntries(
  Object.entries(errorPolicy).map(([code, policy]) => {
    if (!Number.isSafeInteger(policy?.status) || typeof policy.retryable !== "boolean") {
      throw new Error(`invalid error policy for ${code}`);
    }
    return [code, [policy.status, policy.retryable]];
  }),
));

const requestBodyLimits = openapi["x-sumi-request-body-limits"];
if (!requestBodyLimits || typeof requestBodyLimits !== "object") {
  throw new Error("OpenAPI x-sumi-request-body-limits is required");
}
function bodyLimit(name) {
  const value = requestBodyLimits[name];
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("OpenAPI request body limit " + name + " must be a positive integer");
  }
  return value;
}
export const REQUEST_BODY_LIMITS = Object.freeze({
  askJson: bodyLimit("ask_json_bytes"),
  askMultipart: bodyLimit("ask_multipart_bytes"),
  ttsJson: bodyLimit("tts_json_bytes"),
  reviewJson: bodyLimit("review_json_bytes"),
});

export const OUTPUT_MODES = new Set(enumValues("TextAskRequest", "output_mode"));
export const LOCALES = new Set(enumValues("Locale"));
export const AUDIO_TYPES = new Set(enumValues("AudioInput", "content_type"));
export const TTS_FORMATS = new Set(enumValues("TtsRequest", "format"));
export const DEFAULT_LOCALE = schemas.Locale?.default ?? "zh-CN";
export const DEFAULT_AUDIO_OUTPUT_MODE = schemas.MultipartAskMetadata?.properties?.output_mode?.default ?? "both";
export const TEXT_MAX_LENGTH = schemaLimit("TextInput", "text", "maxLength");
export const TTS_TEXT_MAX_LENGTH = schemaLimit("TtsRequest", "text", "maxLength");

const reviewIdPattern = schemas.ReviewId?.pattern;
if (typeof reviewIdPattern !== "string") throw new Error("ReviewId schema must expose a pattern");
export const REVIEW_ID_PATTERN = new RegExp(reviewIdPattern);
