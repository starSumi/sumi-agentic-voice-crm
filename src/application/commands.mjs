import { sha256, validateIdempotencyKey } from "../contracts.mjs";
import {
  AUDIO_TYPES,
  LOCALES,
  OUTPUT_MODES,
  REVIEW_ID_PATTERN,
  TEXT_MAX_LENGTH,
  TTS_FORMATS,
  TTS_TEXT_MAX_LENGTH,
} from "../protocol-policy.mjs";

const askCommands = new WeakSet();
const ttsCommands = new WeakSet();
const reviewCommands = new WeakSet();

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST" });
}

function freezeJson(value) {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freezeJson(entry);
  }
  return value && typeof value === "object" ? Object.freeze(value) : value;
}

function optionalString(value, name, maxLength) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw invalid(`${name} must be a string no longer than ${maxLength} characters`);
  }
  return value;
}

function locale(value) {
  if (!LOCALES.has(value)) throw invalid("locale is outside the published contract");
  return value;
}

export function normalizeAskCommand({ idempotency_key, input, locale: requestedLocale, output_mode, conversation_id } = {}) {
  const idempotencyKey = validateIdempotencyKey(idempotency_key);
  const normalizedLocale = locale(requestedLocale);
  if (!OUTPUT_MODES.has(output_mode)) throw invalid("output mode is outside the published contract");
  const conversationId = optionalString(conversation_id, "conversation_id", 128);

  let normalizedInput;
  if (input?.type === "text") {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > TEXT_MAX_LENGTH) throw invalid("text input is outside the published contract");
    normalizedInput = Object.freeze({ type: "text", text });
  } else if (input?.type === "audio") {
    const bytes = Buffer.isBuffer(input.data) || input.data instanceof Uint8Array
      ? Buffer.from(input.data)
      : undefined;
    if (!bytes?.length) throw invalid("audio input is empty");
    if (bytes.length > 25 * 1024 * 1024) throw invalid("audio input exceeds 25 MB");
    if (!AUDIO_TYPES.has(input.content_type)) throw invalid("audio content type is outside the published contract");
    normalizedInput = Object.freeze({
      type: "audio",
      data_base64: bytes.toString("base64"),
      content_type: input.content_type,
      sha256: sha256(bytes),
    });
  } else {
    throw invalid("ask input must be normalized text or audio");
  }

  const command = Object.freeze({
    idempotencyKey,
    input: normalizedInput,
    locale: normalizedLocale,
    outputMode: output_mode,
    conversationId,
  });
  askCommands.add(command);
  return command;
}

export function normalizeTtsCommand({ idempotency_key, text, language, voice, format } = {}) {
  const idempotencyKey = validateIdempotencyKey(idempotency_key);
  const normalizedText = typeof text === "string" ? text.trim() : "";
  if (!normalizedText || normalizedText.length > TTS_TEXT_MAX_LENGTH) {
    throw invalid("TTS text is outside the published contract");
  }
  const normalizedLanguage = locale(language);
  if (!TTS_FORMATS.has(format)) throw invalid("TTS format is outside the published contract");
  const normalizedVoice = optionalString(voice, "voice", 128) ?? "default";
  if (!normalizedVoice) throw invalid("voice must not be empty");
  const command = Object.freeze({
    idempotencyKey,
    text: normalizedText,
    language: normalizedLanguage,
    voice: normalizedVoice,
    format,
  });
  ttsCommands.add(command);
  return command;
}

export function normalizeReviewCommand({ idempotency_key, review_id, decision, correction } = {}) {
  const idempotencyKey = validateIdempotencyKey(idempotency_key);
  if (typeof review_id !== "string" || !REVIEW_ID_PATTERN.test(review_id)) {
    throw invalid("review id is outside the published contract");
  }
  if (decision !== "approve" && decision !== "reject") {
    throw invalid("review decision is outside the published contract");
  }
  const normalizedCorrection = correction === undefined
    ? undefined
    : freezeJson(structuredClone(correction));
  const command = Object.freeze({
    idempotencyKey,
    reviewId: review_id,
    decision,
    correction: normalizedCorrection,
  });
  reviewCommands.add(command);
  return command;
}

export function assertRequestContext(context) {
  if (
    !context ||
    !Object.isFrozen(context) ||
    !Object.isFrozen(context.identity) ||
    !context.request_id ||
    !context.identity?.tenant_id ||
    !context.identity?.actor_id
  ) {
    throw new TypeError("application services require an immutable request context");
  }
}

export function assertAskCommand(command) {
  if (!askCommands.has(command)) throw new TypeError("AskService requires a normalized ask command");
}

export function assertTtsCommand(command) {
  if (!ttsCommands.has(command)) throw new TypeError("TtsService requires a normalized TTS command");
}

export function assertReviewCommand(command) {
  if (!reviewCommands.has(command)) throw new TypeError("ReviewService requires a normalized review command");
}
