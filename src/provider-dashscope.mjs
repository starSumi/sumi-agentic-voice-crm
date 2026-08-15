import { audioMagicType } from "./contracts.mjs";
import {
  MAX_PROVIDER_AUDIO_BYTES,
  bearerHeaders,
  canonicalAudioContentType,
  checkedJson,
  makeAudioAsset,
  normalizeTranscript,
  parseUnderstanding,
  positiveInteger,
  readBoundedBody,
  trimBaseUrl,
  upstream,
  validateTtsText,
} from "./provider-common.mjs";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_TTS_MAX_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_REDIRECTS = 3;
const MAX_ASR_DATA_URL_BYTES = 10 * 1024 * 1024;
const AUDIO_MIME_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/ogg", "audio/mp4", "audio/webm"]);

function setting(env, name, alias, fallback) {
  return env[name] || env[alias] || fallback;
}

function messageContent(body) {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item.text ?? "").join("");
  return undefined;
}

function nativeTtsUrl(compatibleBaseUrl) {
  return new URL("/api/v1/services/aigc/multimodal-generation/generation", compatibleBaseUrl).toString();
}

function languageType(locale) {
  if (locale === "zh-CN") return "Chinese";
  if (locale === "en-US") return "English";
  return undefined;
}

function audioHostSuffixes(env) {
  const raw = setting(env, "DASHSCOPE_AUDIO_HOST_SUFFIXES", "ALIYUN_AUDIO_HOST_SUFFIXES");
  const configured = raw?.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return configured?.length ? configured : [];
}

function assertAllowedAudioUrl(rawUrl, env) {
  let url;
  try { url = new URL(rawUrl); }
  catch (error) { throw upstream("DashScope TTS returned an invalid audio URL", error); }
  if (url.protocol === "http:" && !url.port) url.protocol = "https:";
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw upstream("DashScope TTS audio URL must use credential-free HTTPS on the default port");
  }
  const hostname = url.hostname.toLowerCase();
  const officialResultHost = /^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(hostname);
  const configuredHost = audioHostSuffixes(env).some((suffix) => {
    const normalized = suffix.startsWith(".") ? suffix : `.${suffix}`;
    return hostname === normalized.slice(1) || hostname.endsWith(normalized);
  });
  if (!officialResultHost && !configuredHost) throw upstream("DashScope TTS audio URL host is not allowlisted");
  return url;
}

function verifiedMimeType(declaredType, bytes) {
  const declared = declaredType?.split(";", 1)[0].trim().toLowerCase();
  const magic = audioMagicType(bytes);
  const detected = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", mp4: "audio/mp4", webm: "audio/webm" }[magic];
  if (!detected) throw upstream("DashScope TTS download did not return supported audio");
  if (declared && declared !== "application/octet-stream" && !AUDIO_MIME_TYPES.has(declared)) {
    throw upstream("DashScope TTS download returned an unsupported Content-Type");
  }
  const normalizedDeclared = declared === "audio/x-wav" ? "audio/wav" : declared;
  if (normalizedDeclared && normalizedDeclared !== "application/octet-stream" && normalizedDeclared !== detected) {
    throw upstream("DashScope TTS audio bytes do not match Content-Type");
  }
  return detected;
}

function decodeAudioData(raw, maxBytes) {
  if (typeof raw !== "string") throw upstream("DashScope TTS returned malformed audio data");
  let encoded = raw;
  let declaredType;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(raw);
  if (raw.startsWith("data:")) {
    if (!match) throw upstream("DashScope TTS returned malformed audio data");
    [, declaredType, encoded] = match;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw upstream("DashScope TTS returned malformed base64 audio");
  }
  if (encoded.length > 4 * Math.ceil(maxBytes / 3)) throw upstream(`DashScope TTS audio exceeds the ${maxBytes}-byte limit`);
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw upstream("DashScope TTS audio data was empty");
  if (bytes.length > maxBytes) throw upstream(`DashScope TTS audio exceeds the ${maxBytes}-byte limit`);
  return { bytes, mimeType: verifiedMimeType(declaredType, bytes) };
}

async function downloadAudio(initialUrl, { env, fetchImpl, signal }) {
  let url = assertAllowedAudioUrl(initialUrl, env);
  for (let redirects = 0; redirects <= MAX_AUDIO_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === MAX_AUDIO_REDIRECTS) throw upstream("DashScope TTS audio download exceeded the redirect limit");
      const location = response.headers.get("location");
      if (!location) throw upstream("DashScope TTS audio redirect omitted Location");
      url = assertAllowedAudioUrl(new URL(location, url).toString(), env);
      continue;
    }
    if (!response.ok) throw upstream(`DashScope TTS audio download returned HTTP ${response.status}`);
    const configuredLimit = setting(env, "DASHSCOPE_TTS_MAX_BYTES", "ALIYUN_TTS_MAX_BYTES");
    const maxBytes = positiveInteger(configuredLimit, DEFAULT_TTS_MAX_BYTES, "DASHSCOPE_TTS_MAX_BYTES", { max: MAX_PROVIDER_AUDIO_BYTES });
    const bytes = await readBoundedBody(response, maxBytes, "DashScope TTS audio");
    if (!bytes.length) throw upstream("DashScope TTS audio download was empty");
    return { bytes, mimeType: verifiedMimeType(response.headers.get("content-type"), bytes) };
  }
  throw upstream("DashScope TTS audio download failed");
}

export function createDashScopeProvider({ env, fetchImpl }) {
  const baseUrl = () => trimBaseUrl(setting(env, "DASHSCOPE_BASE_URL", "ALIYUN_BASE_URL"), DEFAULT_BASE_URL);
  const apiKey = () => setting(env, "DASHSCOPE_API_KEY", "ALIYUN_BASE_APIKEY");
  const headers = () => bearerHeaders(apiKey());

  return {
    name: "dashscope",
    defaultTtsFormat: "wav",
    configured: () => Boolean(apiKey()),
    async transcribe(audio, { locale, contentType = "audio/wav", signal }) {
      const model = setting(env, "DASHSCOPE_ASR_MODEL", "ALIYUN_ASR_MODEL", "qwen3-asr-flash");
      const dataContentType = canonicalAudioContentType(contentType);
      const prefix = `data:${dataContentType};base64,`;
      const encodedBytes = Buffer.byteLength(prefix) + 4 * Math.ceil(audio.length / 3);
      if (encodedBytes > MAX_ASR_DATA_URL_BYTES) {
        throw Object.assign(new Error("audio exceeds the DashScope ASR 10 MB encoded-input limit"), {
          code: "INVALID_REQUEST",
          breakerEligible: false,
        });
      }
      const dataUrl = `${prefix}${Buffer.from(audio).toString("base64")}`;
      const response = await fetchImpl(`${baseUrl()}/chat/completions`, {
        method: "POST",
        headers: headers(),
        signal,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: dataUrl } }] }],
          stream: false,
          asr_options: { language: locale.split("-")[0], enable_itn: true },
        }),
      });
      const body = await checkedJson(response, "DashScope ASR");
      const text = normalizeTranscript(messageContent(body), "DashScope");
      return { text, language: locale.split("-")[0], confidence: 0.8, provider: "dashscope", model, duration_ms: 0 };
    },
    async understand(transcript, { locale, signal }) {
      const model = setting(env, "DASHSCOPE_MODEL", "ALIYUN_BASE_MODEL", "qwen-plus");
      const response = await fetchImpl(`${baseUrl()}/chat/completions`, {
        method: "POST",
        headers: headers(),
        signal,
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          enable_thinking: false,
          messages: [
            { role: "system", content: "Return only a JSON object with exactly these fields: intent (crm.search, crm.deal.update_stage, or crm.customer.create), confidence (0 to 1), entities (object), missing (string array), needs_confirmation (boolean). Extract CRM intent and entities, never invent identifiers, and require confirmation when identity, target, or mutation is ambiguous." },
            { role: "user", content: transcript },
          ],
        }),
      });
      const body = await checkedJson(response, "DashScope intent");
      const raw = messageContent(body);
      if (!raw) throw upstream("DashScope intent returned no JSON output");
      return parseUnderstanding(raw, { transcript, locale, model });
    },
    async synthesize(text, { language = "zh-CN", voice = "default", format = "wav", signal }) {
      if (!new Set(["zh-CN", "en-US"]).has(language)) {
        throw Object.assign(new Error(`DashScope TTS does not support locale ${language}`), {
          code: "INVALID_REQUEST",
          breakerEligible: false,
        });
      }
      validateTtsText(text, 512, "DashScope");
      if (format !== "wav") {
        throw Object.assign(new Error("DashScope TTS currently supports wav output only"), {
          code: "INVALID_REQUEST",
          breakerEligible: false,
        });
      }
      const model = setting(env, "DASHSCOPE_TTS_MODEL", "ALIYUN_TTS_MODEL", "qwen3-tts-flash");
      const selectedVoice = voice === "default" ? setting(env, "DASHSCOPE_TTS_VOICE", "ALIYUN_TTS_VOICE", "Cherry") : voice;
      const input = { text, voice: selectedVoice };
      const type = languageType(language);
      if (type) input.language_type = type;
      const response = await fetchImpl(nativeTtsUrl(baseUrl()), {
        method: "POST",
        headers: headers(),
        signal,
        body: JSON.stringify({ model, input }),
      });
      const body = await checkedJson(response, "DashScope TTS");
      const audio = body.output?.audio;
      if (!audio?.data && !audio?.url) throw upstream("DashScope TTS returned no audio data or URL");
      const configuredLimit = setting(env, "DASHSCOPE_TTS_MAX_BYTES", "ALIYUN_TTS_MAX_BYTES");
      const maxBytes = positiveInteger(configuredLimit, DEFAULT_TTS_MAX_BYTES, "DASHSCOPE_TTS_MAX_BYTES", { max: MAX_PROVIDER_AUDIO_BYTES });
      const { bytes, mimeType } = audio.data
        ? decodeAudioData(audio.data, maxBytes)
        : await downloadAudio(audio.url, { env, fetchImpl, signal });
      const actualFormat = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/mpeg": "mp3" }[mimeType] || "audio";
      if (actualFormat !== format) throw upstream("DashScope TTS audio did not match the requested WAV format");
      return makeAudioAsset(bytes, {
        text, language, voice: selectedVoice, format: actualFormat, mimeType, provider: "dashscope", model,
      });
    },
  };
}
