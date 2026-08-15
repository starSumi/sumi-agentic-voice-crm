import {
  INTENT_SCHEMA,
  MAX_PROVIDER_AUDIO_BYTES,
  bearerHeaders,
  canonicalAudioContentType,
  checkedJson,
  makeAudioAsset,
  mimeForFormat,
  normalizeTranscript,
  parseUnderstanding,
  positiveInteger,
  readBoundedBody,
  trimBaseUrl,
  upstream,
  validateTtsText,
} from "./provider-common.mjs";
import { audioMagicType } from "./contracts.mjs";

const DEFAULT_TTS_MAX_BYTES = 10 * 1024 * 1024;

export function createOpenAiProvider({ env, fetchImpl }) {
  const baseUrl = () => trimBaseUrl(env.OPENAI_BASE_URL, "https://api.openai.com/v1");
  const headers = (contentType = "application/json") => bearerHeaders(
    env.OPENAI_API_KEY,
    contentType,
    env.OPENAI_ACTOR_AUTHORIZATION ? { "x-openai-actor-authorization": env.OPENAI_ACTOR_AUTHORIZATION } : {},
  );

  return {
    name: "openai-compatible",
    defaultTtsFormat: "mp3",
    configured: (kind) => Boolean(env.OPENAI_API_KEY && (kind !== "intent" || env.OPENAI_MODEL)),
    async transcribe(audio, { locale, contentType = "audio/wav", signal }) {
      const model = env.OPENAI_ASR_MODEL || "whisper-1";
      const uploadType = canonicalAudioContentType(contentType);
      const extension = { "audio/wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/webm": "webm" }[uploadType] || "audio";
      const form = new FormData();
      form.append("file", new Blob([audio], { type: uploadType }), `input.${extension}`);
      form.append("model", model);
      form.append("language", locale.split("-")[0]);
      const response = await fetchImpl(`${baseUrl()}/audio/transcriptions`, { method: "POST", headers: headers(null), body: form, signal });
      const body = await checkedJson(response, "ASR provider");
      const text = normalizeTranscript(body.text ?? "", "OpenAI");
      return {
        text,
        language: body.language ?? locale.split("-")[0],
        confidence: body.confidence ?? 0.8,
        provider: "openai-compatible",
        model,
        duration_ms: body.duration_ms ?? 0,
      };
    },
    async understand(transcript, { locale, signal }) {
      const model = env.OPENAI_MODEL;
      if (!model) throw upstream("OPENAI_MODEL is required for intent extraction", undefined, { breakerEligible: false });
      const response = await fetchImpl(`${baseUrl()}/responses`, {
        method: "POST",
        headers: headers(),
        signal,
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: [{ type: "input_text", text: "Extract a CRM intent and key entities. Never invent identifiers. Set needs_confirmation when identity, target, or mutation is ambiguous." }] },
            { role: "user", content: [{ type: "input_text", text: transcript }] },
          ],
          text: { format: { type: "json_schema", name: "crm_understanding", strict: true, schema: INTENT_SCHEMA } },
        }),
      });
      const body = await checkedJson(response, "intent provider");
      const raw = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
      if (!raw) throw upstream("intent provider returned no structured output");
      return parseUnderstanding(raw, { transcript, locale, model });
    },
    async synthesize(text, { language = "zh-CN", voice = "default", format = "mp3", signal }) {
      validateTtsText(text, 4096, "OpenAI");
      const model = env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
      const selectedVoice = voice === "default" ? (env.OPENAI_TTS_VOICE || "alloy") : voice;
      const responseFormat = format === "ogg" ? "opus" : format;
      const response = await fetchImpl(`${baseUrl()}/audio/speech`, {
        method: "POST",
        headers: headers(),
        signal,
        body: JSON.stringify({ model, input: text, voice: selectedVoice, response_format: responseFormat }),
      });
      if (!response.ok) await checkedJson(response, "TTS provider");
      const maxBytes = positiveInteger(
        env.OPENAI_TTS_MAX_BYTES || env.PROVIDER_TTS_MAX_BYTES,
        DEFAULT_TTS_MAX_BYTES,
        "OPENAI_TTS_MAX_BYTES",
        { max: MAX_PROVIDER_AUDIO_BYTES },
      );
      const bytes = await readBoundedBody(response, maxBytes, "OpenAI TTS audio");
      if (!bytes.length) throw upstream("TTS provider returned empty audio");
      const actualFormat = audioMagicType(bytes);
      if (!actualFormat || actualFormat !== format) throw upstream("TTS provider audio bytes do not match the requested format");
      return makeAudioAsset(bytes, {
        text, language, voice: selectedVoice, format, mimeType: mimeForFormat(actualFormat), provider: "openai-compatible", model,
      });
    },
  };
}
