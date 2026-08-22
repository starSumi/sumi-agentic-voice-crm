import openapi from "../protocol/schema/json/openapi.bundle.json" with { type: "json" };

type JsonSchema = {
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly maxLength?: unknown;
  readonly pattern?: unknown;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
};

type OpenApiBundle = {
  readonly components?: { readonly schemas?: Readonly<Record<string, JsonSchema>> };
  readonly ["x-sumi-error-policy"]?: unknown;
  readonly ["x-sumi-request-body-limits"]?: unknown;
};

const document = openapi as unknown as OpenApiBundle;
const schemas = document.components?.schemas ?? {};

function enumValues(schemaName: string, propertyName?: string): readonly string[] {
  const values = propertyName === undefined
    ? schemas[schemaName]?.enum
    : schemas[schemaName]?.properties?.[propertyName]?.enum;
  if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === "string")) {
    throw new Error(`protocol schema ${schemaName}.${propertyName} must expose a non-empty enum`);
  }
  return Object.freeze([...values]);
}

function schemaLimit(schemaName: string, propertyName: string, limitName: "maxLength"): number {
  const value = schemas[schemaName]?.properties?.[propertyName]?.[limitName];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`protocol schema ${schemaName}.${propertyName} must expose a positive ${limitName}`);
  }
  return value;
}

const errorPolicy = document["x-sumi-error-policy"];
if (!errorPolicy || typeof errorPolicy !== "object" || Array.isArray(errorPolicy)) {
  throw new Error("OpenAPI x-sumi-error-policy is required");
}

export type ErrorCodePolicy = readonly [status: number, retryable: boolean];
export const ERROR_CODES: Readonly<Record<string, ErrorCodePolicy>> = Object.freeze(Object.fromEntries(
  Object.entries(errorPolicy as Record<string, unknown>).map(([code, policy]) => {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      throw new Error(`invalid error policy for ${code}`);
    }
    const status = (policy as Record<string, unknown>).status;
    const retryable = (policy as Record<string, unknown>).retryable;
    if (!Number.isSafeInteger(status) || typeof retryable !== "boolean") {
      throw new Error(`invalid error policy for ${code}`);
    }
    return [code, [status, retryable] as const];
  }),
) as Record<string, ErrorCodePolicy>);

const requestBodyLimits = document["x-sumi-request-body-limits"];
if (!requestBodyLimits || typeof requestBodyLimits !== "object" || Array.isArray(requestBodyLimits)) {
  throw new Error("OpenAPI x-sumi-request-body-limits is required");
}
function bodyLimit(name: string): number {
  const value = (requestBodyLimits as Record<string, unknown>)[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
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

export const OUTPUT_MODES: ReadonlySet<string> = new Set(enumValues("TextAskRequest", "output_mode"));
export const LOCALES: ReadonlySet<string> = new Set(enumValues("Locale"));
export const AUDIO_TYPES: ReadonlySet<string> = new Set(enumValues("AudioInput", "content_type"));
export const TTS_FORMATS: ReadonlySet<string> = new Set(enumValues("TtsRequest", "format"));
export const DEFAULT_LOCALE = typeof schemas.Locale?.default === "string" ? schemas.Locale.default : "zh-CN";
export const DEFAULT_AUDIO_OUTPUT_MODE = typeof schemas.MultipartAskMetadata?.properties?.output_mode?.default === "string"
  ? schemas.MultipartAskMetadata.properties.output_mode.default
  : "both";
export const TEXT_MAX_LENGTH = schemaLimit("TextInput", "text", "maxLength");
export const TTS_TEXT_MAX_LENGTH = schemaLimit("TtsRequest", "text", "maxLength");

const reviewIdPattern = schemas.ReviewId?.pattern;
if (typeof reviewIdPattern !== "string") throw new Error("ReviewId schema must expose a pattern");
export const REVIEW_ID_PATTERN = new RegExp(reviewIdPattern);
