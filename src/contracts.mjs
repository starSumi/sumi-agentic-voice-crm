import { createHash, randomUUID } from "node:crypto";

export const API_VERSION = "v1";
export const INTENT_SCHEMA_VERSION = "understanding.v1";
export const OUTPUT_MODES = new Set(["text", "audio", "both"]);
export const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/webm"]);
export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: [400, false], UNAUTHORIZED: [401, false], FORBIDDEN: [403, false],
  UNSUPPORTED_MEDIA: [415, false], NO_AUDIO_SOURCE: [422, false], EMPTY_TRANSCRIPT: [422, false],
  INTENT_LOW_CONFIDENCE: [202, false], CRM_CONFLICT: [409, true], ASR_TIMEOUT: [504, true],
  IDEMPOTENCY_CONFLICT: [409, false], UPSTREAM_UNAVAILABLE: [503, true], RATE_LIMITED: [429, true]
});

export function requestId() { return `req_${randomUUID().replaceAll("-", "").slice(0, 24)}`; }
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function now() { return new Date().toISOString(); }

export function errorEnvelope(code, message, request_id, details = {}) {
  const [status, retryable] = ERROR_CODES[code] ?? [500, false];
  return { status: "failed", request_id, error: { code, message, retryable, details } };
}

export function assertTenant(headers) {
  const tenant = headers.get("x-tenant-id");
  const auth = headers.get("authorization");
  if (!auth?.startsWith("Bearer ") || !auth.slice(7).trim()) throw Object.assign(new Error("authentication required"), { code: "UNAUTHORIZED" });
  if (!tenant?.trim()) throw Object.assign(new Error("X-Tenant-Id is required"), { code: "INVALID_REQUEST" });
  return { tenant_id: tenant.trim(), actor_id: auth.slice(7).trim().slice(0, 80) };
}

export function validateIdempotencyKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw Object.assign(new Error("Idempotency-Key must be 8-128 safe characters"), { code: "INVALID_REQUEST" });
  }
  return value;
}

export function validateTextAsk(body) {
  if (!body || typeof body !== "object" || body.input?.type !== "text" || typeof body.input.text !== "string" || !body.input.text.trim()) {
    throw Object.assign(new Error("input.type=text and non-empty input.text are required"), { code: "INVALID_REQUEST" });
  }
  if (!OUTPUT_MODES.has(body.output_mode)) throw Object.assign(new Error("output_mode must be text, audio or both"), { code: "INVALID_REQUEST" });
  if (body.input.text.length > 10000) throw Object.assign(new Error("text exceeds 10000 characters"), { code: "INVALID_REQUEST" });
  return { type: "text", text: body.input.text.trim(), locale: body.locale ?? "zh-CN", output_mode: body.output_mode, conversation_id: body.conversation_id };
}

export function validateAudioInput({ data, content_type, locale = "zh-CN", output_mode = "both" }) {
  if (!data || !Buffer.isBuffer(data) || data.length === 0) throw Object.assign(new Error("audio part is empty"), { code: "NO_AUDIO_SOURCE" });
  if (!AUDIO_TYPES.has(content_type)) throw Object.assign(new Error(`unsupported audio content type: ${content_type}`), { code: "UNSUPPORTED_MEDIA" });
  if (data.length > 25 * 1024 * 1024) throw Object.assign(new Error("audio exceeds 25 MB"), { code: "INVALID_REQUEST" });
  if (!OUTPUT_MODES.has(output_mode)) throw Object.assign(new Error("invalid output_mode"), { code: "INVALID_REQUEST" });
  return { type: "audio", data, content_type, locale, output_mode };
}

export function understanding({ intent, confidence, entities = {}, missing = [], needs_confirmation = false, transcript, language = "zh" }) {
  return { intent, confidence, entities, missing, needs_confirmation, schema_version: INTENT_SCHEMA_VERSION,
    source: { transcript_hash: `sha256:${sha256(transcript ?? "")}`, language, model: "mock-intent-1" } };
}
