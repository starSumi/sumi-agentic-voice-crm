import { sha256, understanding } from "./contracts.mjs";

export const LOCALES = new Set(["zh-CN", "en-US", "hi-IN", "te-IN"]);
export const MAX_PROVIDER_TIMEOUT_MS = 120_000;
export const MAX_PROVIDER_AUDIO_BYTES = 50 * 1024 * 1024;
export const MAX_PROVIDER_JSON_BYTES = 1 * 1024 * 1024;
export const INTENTS = new Set(["crm.search", "crm.deal.update_stage", "crm.customer.create"]);
export const INTENT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["intent", "confidence", "entities", "missing", "needs_confirmation"],
  properties: {
    intent: { enum: [...INTENTS] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    entities: { type: "object" },
    missing: { type: "array", items: { type: "string" } },
    needs_confirmation: { type: "boolean" },
  },
});

export function upstream(message, cause, { breakerEligible = true } = {}) {
  return Object.assign(new Error(message, { cause }), { code: "UPSTREAM_UNAVAILABLE", breakerEligible });
}

export function trimBaseUrl(value, fallback) {
  return (value || fallback).replace(/\/$/, "");
}

export function bearerHeaders(apiKey, contentType = "application/json", extra = {}) {
  const headers = { authorization: `Bearer ${apiKey ?? ""}`, ...extra };
  if (contentType) headers["content-type"] = contentType;
  return headers;
}

export async function checkedJson(response, label = "provider") {
  assertProviderResponse(response, label);
  const bytes = await readBoundedBody(response, MAX_PROVIDER_JSON_BYTES, `${label} response`);
  let body = {};
  try { body = bytes.length ? JSON.parse(bytes.toString("utf8")) : {}; }
  catch (error) { throw upstream(`${label} returned malformed JSON`, error); }
  return body;
}

export function assertProviderResponse(response, label = "provider") {
  if (response.ok) return;
  if (response.status === 429) {
    throw Object.assign(new Error(`${label} rate limited the request`), { code: "RATE_LIMITED", breakerEligible: true });
  }
  if (response.status >= 400 && response.status < 500) {
    throw Object.assign(new Error(`${label} rejected the request with HTTP ${response.status}`), {
      code: "PROVIDER_REJECTED",
      breakerEligible: false,
    });
  }
  throw upstream(`${label} returned HTTP ${response.status}`, undefined, {
    breakerEligible: response.status >= 500,
  });
}

export function parseUnderstanding(raw, { transcript, locale, model }) {
  let parsed;
  try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch (error) { throw upstream("intent provider returned invalid JSON", error); }

  const validObject = parsed && typeof parsed === "object" && !Array.isArray(parsed);
  const validEntities = parsed?.entities && typeof parsed.entities === "object" && !Array.isArray(parsed.entities);
  const validMissing = Array.isArray(parsed?.missing) && parsed.missing.every((item) => typeof item === "string");
  const validConfidence = Number.isFinite(parsed?.confidence) && parsed.confidence >= 0 && parsed.confidence <= 1;
  if (!validObject || !INTENTS.has(parsed.intent) || !validConfidence || !validEntities || !validMissing || typeof parsed.needs_confirmation !== "boolean") {
    throw upstream("intent provider returned output that does not match the CRM schema");
  }

  const allowed = new Set(INTENT_SCHEMA.required);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) {
    throw upstream("intent provider returned unexpected CRM schema fields");
  }
  return understanding({ ...parsed, transcript, language: locale.split("-")[0], model });
}

export function makeAudioAsset(bytes, { text, language, voice, format, mimeType, provider, model }) {
  const body = Buffer.from(bytes);
  const identity = JSON.stringify({ provider, model, language, voice, format, mimeType, bytes: sha256(body) });
  const assetId = `ast_${sha256(identity).slice(0, 20)}`;
  return {
    asset_id: assetId,
    url: `/v1/assets/${assetId}`,
    mime_type: mimeType,
    duration_ms: Math.max(300, text.length * 65),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    voice,
    provider,
    model,
    status: "ready",
    data_base64: body.toString("base64"),
  };
}

export function mimeForFormat(format) {
  if (format === "wav") return "audio/wav";
  if (format === "ogg") return "audio/ogg";
  return "audio/mpeg";
}

export function positiveInteger(value, fallback, label, { max } = {}) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || (max !== undefined && parsed > max)) {
    const suffix = max === undefined ? "" : ` no greater than ${max}`;
    throw upstream(`${label} must be a positive integer${suffix}`, undefined, { breakerEligible: false });
  }
  return parsed;
}

export function canonicalAudioContentType(contentType = "audio/wav") {
  return contentType === "audio/x-wav" ? "audio/wav" : contentType;
}

export function validateTtsText(text, maxChars, provider) {
  if (typeof text !== "string" || !text.trim()) {
    throw Object.assign(new Error(`${provider} TTS text is required`), { code: "INVALID_REQUEST", breakerEligible: false });
  }
  if ([...text].length > maxChars) {
    throw Object.assign(new Error(`${provider} TTS text exceeds ${maxChars} characters`), { code: "INVALID_REQUEST", breakerEligible: false });
  }
}

export function normalizeTranscript(text, provider, maxChars = 10_000) {
  if (typeof text !== "string") throw upstream(`${provider} ASR returned an invalid transcript`);
  if ([...text].length > maxChars) throw upstream(`${provider} ASR returned a transcript over ${maxChars} characters`);
  return text;
}

export async function readBoundedBody(response, maxBytes, label = "provider audio") {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw upstream(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw upstream(`${label} exceeds the ${maxBytes}-byte limit`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}
