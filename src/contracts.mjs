import { createHash, randomUUID } from "node:crypto";
import { AUDIO_TYPES, DEFAULT_LOCALE, ERROR_CODES, LOCALES, OUTPUT_MODES } from "./protocol-policy.mjs";

export { AUDIO_TYPES, ERROR_CODES, LOCALES, OUTPUT_MODES } from "./protocol-policy.mjs";

export const API_VERSION = "v1";
export const INTENT_SCHEMA_VERSION = "understanding.v1";

export function requestId() { return `req_${randomUUID().replaceAll("-", "").slice(0, 24)}`; }
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function now() { return new Date().toISOString(); }

export function errorEnvelope(code, message, request_id, details = {}) {
  const safeCode = ERROR_CODES[code] ? code : "INVALID_REQUEST";
  const [, retryable] = ERROR_CODES[safeCode];
  const safeMessage = (typeof message === "string" ? message : "request failed").trim().slice(0, 1000) || "request failed";
  const safeDetails = details && typeof details === "object" ? details : {};
  return { status: "failed", request_id, error: { code: safeCode, message: safeMessage, retryable, details: safeDetails } };
}

export function assertTenant(headers) {
  const tenant = headers.get("x-tenant-id");
  const auth = headers.get("authorization");
  if (!auth?.startsWith("Bearer ") || !auth.slice(7).trim()) throw Object.assign(new Error("authentication required"), { code: "UNAUTHORIZED" });
  const tenantId = tenant?.trim();
  if (!tenantId) throw Object.assign(new Error("X-Tenant-Id is required"), { code: "INVALID_REQUEST" });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tenantId)) {
    throw Object.assign(new Error("X-Tenant-Id has an invalid format"), { code: "INVALID_REQUEST" });
  }
  const token = auth.slice(7).trim();
  if (token.length > 2048 || /[\r\n]/.test(token)) throw Object.assign(new Error("invalid bearer token"), { code: "UNAUTHORIZED" });

  // Opaque tokens are intentionally accepted because the identity gateway owns
  // verification. When a JWT is supplied locally, enforce its tenant claim so
  // a caller cannot select a different tenant with the same credential.
  const parts = token.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      const tokenTenant = payload.tenant_id ?? payload.tid ?? payload["https://sumi.invalid/tenant_id"];
      if (tokenTenant !== undefined && tokenTenant !== tenantId) {
        throw Object.assign(new Error("token is not bound to this tenant"), { code: "FORBIDDEN" });
      }
    } catch (error) {
      if (error?.code === "FORBIDDEN") throw error;
      // A malformed JWT-shaped opaque token is not accepted. Plain opaque
      // gateway tokens (the normal local/test form) remain supported.
      throw Object.assign(new Error("invalid bearer token"), { code: "UNAUTHORIZED" });
    }
  }
  return { tenant_id: tenantId, actor_id: token.slice(0, 80) };
}

export function validateIdempotencyKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw Object.assign(new Error("Idempotency-Key must be 8-128 safe characters"), { code: "INVALID_REQUEST" });
  }
  return value;
}

export function validateTextAsk(body) {
  // The transport contract has already been validated by validateProtocol.
  // This function only normalizes the accepted DTO for the domain operation.
  if (!body || typeof body !== "object" || body.input?.type !== "text" || typeof body.input.text !== "string") {
    throw Object.assign(new Error("input.type=text and non-empty input.text are required"), { code: "INVALID_REQUEST" });
  }
  if (!body.input.text.trim()) throw Object.assign(new Error("input text must not be empty"), { code: "INVALID_REQUEST" });
  return { type: "text", text: body.input.text.trim(), locale: body.locale ?? DEFAULT_LOCALE, output_mode: body.output_mode, conversation_id: body.conversation_id };
}

export function validateAudioInput({ data, content_type, locale = "zh-CN", output_mode = "both", env = process.env }) {
  if (!data || !Buffer.isBuffer(data) || data.length === 0) throw Object.assign(new Error("audio part is empty"), { code: "NO_AUDIO_SOURCE" });
  if (!AUDIO_TYPES.has(content_type)) throw Object.assign(new Error(`unsupported audio content type: ${content_type}`), { code: "UNSUPPORTED_MEDIA" });
  if (data.length > 25 * 1024 * 1024) throw Object.assign(new Error("audio exceeds 25 MB"), { code: "INVALID_REQUEST" });
  const magic = audioMagicType(data);
  if (magic && !compatibleAudioType(content_type, magic)) {
    throw Object.assign(new Error(`audio bytes do not match ${content_type}`), { code: "UNSUPPORTED_MEDIA" });
  }
  if (!magic && env.ALLOW_MOCK_AUDIO !== "true" && (env.PROVIDER_MODE ?? "mock") !== "mock") {
    throw Object.assign(new Error("audio signature is not recognized"), { code: "UNSUPPORTED_MEDIA" });
  }
  if (!OUTPUT_MODES.has(output_mode) || !LOCALES.has(locale)) throw Object.assign(new Error("audio locale or output mode is outside the published contract"), { code: "INVALID_REQUEST" });
  return { type: "audio", data, content_type, locale, output_mode };
}

export function audioMagicType(data) {
  if (!Buffer.isBuffer(data) || data.length < 4) return undefined;
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WAVE") return "wav";
  if (data.subarray(0, 3).toString("ascii") === "ID3" || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return "mp3";
  if (data.subarray(0, 4).toString("ascii") === "OggS") return "ogg";
  if (data.subarray(0, 4).toString("ascii") === "\u001aE\udfa3") return "webm";
  if (data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
  return undefined;
}

function compatibleAudioType(contentType, magic) {
  return ({ wav: ["audio/wav", "audio/x-wav"], mp3: ["audio/mpeg"], webm: ["audio/webm"], mp4: ["audio/mp4"], ogg: ["audio/ogg"] }[magic] ?? []).includes(contentType);
}

export function understanding({ intent, confidence, entities = {}, missing = [], needs_confirmation = false, transcript, language = "zh", model = "mock-intent-1" }) {
  return { intent, confidence, entities, missing, needs_confirmation, schema_version: INTENT_SCHEMA_VERSION,
    source: { transcript_hash: `sha256:${sha256(transcript ?? "")}`, language, model } };
}
