import { sha256 } from "../contracts.ts";
import { z } from "zod";
import {
  AUDIO_TYPES,
  LOCALES,
  OUTPUT_MODES,
  REVIEW_ID_PATTERN,
  TEXT_MAX_LENGTH,
  TTS_FORMATS,
  TTS_TEXT_MAX_LENGTH,
} from "../protocol-policy.ts";

type RuntimeError = Error & { code: string };
type JsonObject = Record<string, unknown>;
type AskCommandInput = {
  idempotency_key?: unknown;
  input?: unknown;
  locale?: unknown;
  output_mode?: unknown;
  conversation_id?: unknown;
};
type TtsCommandInput = {
  idempotency_key?: unknown;
  text?: unknown;
  language?: unknown;
  voice?: unknown;
  format?: unknown;
};
type ReviewCommandInput = {
  idempotency_key?: unknown;
  review_id?: unknown;
  decision?: unknown;
  correction?: unknown;
};
export type ApplicationRequestContext = {
  readonly request_id: string;
  readonly identity: Readonly<{ tenant_id: string; actor_id: string; [key: string]: unknown }>;
  readonly signal?: AbortSignal;
  readonly traceparent?: string;
  readonly conversation_id?: string;
};

const askCommands = new WeakSet<object>();
const ttsCommands = new WeakSet<object>();
const reviewCommands = new WeakSet<object>();

const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/u);
const boundedOptionalString = (maxLength: number) => z.string().max(maxLength).optional();
const localeSchema = z.string().refine((value) => LOCALES.has(value));
const outputModeSchema = z.string().refine((value) => OUTPUT_MODES.has(value));
const audioTypeSchema = z.string().refine((value) => AUDIO_TYPES.has(value));
const ttsFormatSchema = z.string().refine((value) => TTS_FORMATS.has(value));
const textInputSchema = z.object({
  type: z.literal("text"),
  text: z.string().trim().min(1).max(TEXT_MAX_LENGTH),
});
const audioInputSchema = z.object({
  type: z.literal("audio"),
  data: z.unknown(),
  content_type: z.unknown(),
});

function parseOrInvalid<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid(message);
  return result.data;
}

function invalid(message: string): RuntimeError {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST" });
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freezeJson(entry);
  }
  return value && typeof value === "object" ? Object.freeze(value) : value;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  const result = boundedOptionalString(maxLength).safeParse(value);
  if (!result.success) {
    throw invalid(`${name} must be a string no longer than ${maxLength} characters`);
  }
  return result.data;
}

function locale(value: unknown): string {
  return parseOrInvalid(localeSchema, value, "locale is outside the published contract");
}

export function normalizeAskCommand({ idempotency_key, input, locale: requestedLocale, output_mode, conversation_id }: AskCommandInput = {}) {
  const idempotencyKey = parseOrInvalid(idempotencyKeySchema, idempotency_key, "Idempotency-Key must be 8-128 safe characters");
  const normalizedLocale = locale(requestedLocale);
  const normalizedOutputMode = parseOrInvalid(outputModeSchema, output_mode, "output mode is outside the published contract");
  const conversationId = optionalString(conversation_id, "conversation_id", 128);

  let normalizedInput;
  const rawInput = input && typeof input === "object" ? input as JsonObject : undefined;
  if (rawInput?.type === "text") {
    const textInput = parseOrInvalid(textInputSchema, rawInput, "text input is outside the published contract");
    normalizedInput = Object.freeze(textInput);
  } else if (rawInput?.type === "audio") {
    const audioInput = parseOrInvalid(audioInputSchema, rawInput, "audio input is outside the published contract");
    const bytes = Buffer.isBuffer(audioInput.data) || audioInput.data instanceof Uint8Array
      ? Buffer.from(audioInput.data)
      : undefined;
    if (!bytes?.length) throw invalid("audio input is empty");
    if (bytes.length > 25 * 1024 * 1024) throw invalid("audio input exceeds 25 MB");
    const contentType = parseOrInvalid(audioTypeSchema, audioInput.content_type, "audio content type is outside the published contract");
    normalizedInput = Object.freeze({
      type: "audio",
      data_base64: bytes.toString("base64"),
      content_type: contentType,
      sha256: sha256(bytes),
    });
  } else {
    throw invalid("ask input must be normalized text or audio");
  }

  const command = Object.freeze({
    idempotencyKey,
    input: normalizedInput,
    locale: normalizedLocale,
    outputMode: normalizedOutputMode,
    conversationId,
  });
  askCommands.add(command);
  return command;
}

export function normalizeTtsCommand({ idempotency_key, text, language, voice, format }: TtsCommandInput = {}) {
  const idempotencyKey = parseOrInvalid(idempotencyKeySchema, idempotency_key, "Idempotency-Key must be 8-128 safe characters");
  const normalizedText = parseOrInvalid(z.string().trim().min(1).max(TTS_TEXT_MAX_LENGTH), text, "TTS text is outside the published contract");
  const normalizedLanguage = locale(language);
  const normalizedFormat = parseOrInvalid(ttsFormatSchema, format, "TTS format is outside the published contract");
  const normalizedVoice = optionalString(voice, "voice", 128) ?? "default";
  if (!normalizedVoice) throw invalid("voice must not be empty");
  const command = Object.freeze({
    idempotencyKey,
    text: normalizedText,
    language: normalizedLanguage,
    voice: normalizedVoice,
    format: normalizedFormat,
  });
  ttsCommands.add(command);
  return command;
}

export function normalizeReviewCommand({ idempotency_key, review_id, decision, correction }: ReviewCommandInput = {}) {
  const idempotencyKey = parseOrInvalid(idempotencyKeySchema, idempotency_key, "Idempotency-Key must be 8-128 safe characters");
  const reviewId = parseOrInvalid(z.string().regex(REVIEW_ID_PATTERN), review_id, "review id is outside the published contract");
  const normalizedDecision = parseOrInvalid(z.enum(["approve", "reject"]), decision, "review decision is outside the published contract");
  const normalizedCorrection = correction === undefined
    ? undefined
    : freezeJson(structuredClone(correction));
  const command = Object.freeze({
    idempotencyKey,
    reviewId,
    decision: normalizedDecision,
    correction: normalizedCorrection,
  });
  reviewCommands.add(command);
  return command;
}

export function assertRequestContext(context: ApplicationRequestContext): void {
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

export function assertAskCommand(command: object): void {
  if (!askCommands.has(command)) throw new TypeError("AskService requires a normalized ask command");
}

export function assertTtsCommand(command: object): void {
  if (!ttsCommands.has(command)) throw new TypeError("TtsService requires a normalized TTS command");
}

export function assertReviewCommand(command: object): void {
  if (!reviewCommands.has(command)) throw new TypeError("ReviewService requires a normalized review command");
}
