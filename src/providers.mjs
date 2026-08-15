import { sha256, understanding } from "./contracts.mjs";

const LOCALES = new Set(["zh-CN", "en-US", "hi-IN", "te-IN"]);
const DEFAULT_TIMEOUT_MS = 15_000;

class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 30_000 } = {}) { this.threshold = threshold; this.cooldownMs = cooldownMs; this.failures = 0; this.openUntil = 0; }
  async run(operation) {
    if (Date.now() < this.openUntil) throw upstream("provider circuit is open");
    try { const result = await operation(); this.failures = 0; this.openUntil = 0; return result; }
    catch (error) { this.failures += 1; if (this.failures >= this.threshold) this.openUntil = Date.now() + this.cooldownMs; throw error; }
  }
  snapshot() { return { state: Date.now() < this.openUntil ? "open" : "closed", failures: this.failures }; }
}

const breakers = { asr: new CircuitBreaker(), intent: new CircuitBreaker(), tts: new CircuitBreaker() };

function upstream(message, cause) { return Object.assign(new Error(message, { cause }), { code: "UPSTREAM_UNAVAILABLE" }); }

async function timed(kind, operation, timeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)) {
  return await breakers[kind].run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await operation(controller.signal); }
    catch (error) {
      if (error?.name === "AbortError") throw Object.assign(new Error(`${kind} provider timed out`), { code: kind === "asr" ? "ASR_TIMEOUT" : "UPSTREAM_UNAVAILABLE" });
      if (error?.code) throw error;
      throw upstream(`${kind} provider failed`, error);
    } finally { clearTimeout(timer); }
  });
}

function baseUrl() { return (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""); }
function authHeaders(contentType = "application/json") {
  const headers = { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` };
  if (contentType) headers["content-type"] = contentType;
  if (process.env.OPENAI_ACTOR_AUTHORIZATION) headers["x-openai-actor-authorization"] = process.env.OPENAI_ACTOR_AUTHORIZATION;
  return headers;
}
async function checkedJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw upstream(`provider returned HTTP ${response.status}: ${body.error?.message ?? "request failed"}`);
  return body;
}

function providerNames() {
  return { asr: process.env.ASR_PROVIDER || "mock", intent: process.env.INTENT_PROVIDER || "mock", tts: process.env.TTS_PROVIDER || "mock" };
}

export function providerReadiness() {
  const names = providerNames();
  const statuses = Object.fromEntries(Object.entries(names).map(([kind, name]) => {
    const configured = name === "mock" || (name === "openai-compatible" && Boolean(process.env.OPENAI_API_KEY));
    return [kind, { provider: name, ready: configured && breakers[kind].snapshot().state !== "open", reason: configured ? undefined : "credentials_or_adapter_missing", circuit: breakers[kind].snapshot().state }];
  }));
  return { names, statuses, ready: Object.values(statuses).every(({ ready }) => ready) };
}

export async function transcribe(audio, { locale }) {
  if (!LOCALES.has(locale)) throw Object.assign(new Error("unsupported ASR locale"), { code: "INVALID_REQUEST" });
  const provider = providerNames().asr;
  if (provider === "mock") {
    const text = audio.toString("utf8").replace(/^MOCK_AUDIO:/, "").trim();
    if (!text || /^silence$/i.test(text)) return { text: "", language: locale.split("-")[0], confidence: 0.01, provider, model: "mock-asr-1", duration_ms: 10 };
    return { text, language: locale.split("-")[0], confidence: 0.98, provider, model: "mock-asr-1", duration_ms: 10 };
  }
  if (provider !== "openai-compatible") throw upstream(`unsupported ASR provider: ${provider}`);
  return await timed("asr", async (signal) => {
    const form = new FormData();
    form.append("file", new Blob([audio]), "input.audio");
    form.append("model", process.env.OPENAI_ASR_MODEL || "whisper-1");
    form.append("language", locale.split("-")[0]);
    const response = await fetch(`${baseUrl()}/audio/transcriptions`, { method: "POST", headers: authHeaders(null), body: form, signal });
    const body = await checkedJson(response);
    return { text: body.text ?? "", language: body.language ?? locale.split("-")[0], confidence: body.confidence ?? 0.8, provider, model: process.env.OPENAI_ASR_MODEL || "whisper-1", duration_ms: body.duration_ms ?? 0 };
  });
}

export async function understand(transcript, { locale }) {
  if (!LOCALES.has(locale)) throw Object.assign(new Error("unsupported intent locale"), { code: "INVALID_REQUEST" });
  const provider = providerNames().intent;
  if (provider === "mock") return mockUnderstand(transcript, locale);
  if (provider !== "openai-compatible") throw upstream(`unsupported intent provider: ${provider}`);
  return await timed("intent", async (signal) => {
    const schema = { type: "object", additionalProperties: false, required: ["intent", "confidence", "entities", "missing", "needs_confirmation"], properties: { intent: { enum: ["crm.search", "crm.deal.update_stage", "crm.customer.create"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, entities: { type: "object" }, missing: { type: "array", items: { type: "string" } }, needs_confirmation: { type: "boolean" } } };
    const response = await fetch(`${baseUrl()}/responses`, { method: "POST", headers: authHeaders(), signal, body: JSON.stringify({ model: process.env.OPENAI_MODEL, input: [{ role: "system", content: [{ type: "input_text", text: "Extract a CRM intent and key entities. Never invent identifiers. Set needs_confirmation when identity, target, or mutation is ambiguous." }] }, { role: "user", content: [{ type: "input_text", text: transcript }] }], text: { format: { type: "json_schema", name: "crm_understanding", strict: true, schema } } }) });
    const body = await checkedJson(response);
    const raw = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
    if (!raw) throw upstream("intent provider returned no structured output");
    const parsed = JSON.parse(raw);
    return understanding({ ...parsed, transcript, language: locale.split("-")[0], model: process.env.OPENAI_MODEL || "unknown" });
  });
}

export async function synthesize(text, { language = "zh-CN", voice = "default", format = "mp3" }) {
  const provider = providerNames().tts;
  if (provider === "mock") return mockAsset(text, language, voice, format);
  if (provider !== "openai-compatible") throw upstream(`unsupported TTS provider: ${provider}`);
  return await timed("tts", async (signal) => {
    const response = await fetch(`${baseUrl()}/audio/speech`, { method: "POST", headers: authHeaders(), signal, body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", input: text, voice, response_format: format }) });
    if (!response.ok) throw upstream(`TTS provider returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const asset = mockAsset(text, language, voice, format);
    return { ...asset, provider, model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", byte_length: bytes.length, sha256: sha256(bytes), data_base64: bytes.toString("base64") };
  });
}

function mockUnderstand(transcript, locale) {
  const t = transcript.toLowerCase(); let intent = "crm.search"; let confidence = 0.91; const entities = {};
  if (t.includes("move") || t.includes("stage") || t.includes("阶段") || t.includes("negotiation")) { intent = "crm.deal.update_stage"; entities.deal = { value: "d1", name: "Acme renewal", confidence: 0.96 }; entities.stage = { value: "Negotiation", confidence: 0.99 }; }
  else if (t.includes("ramesh") || t.includes("customer") || t.includes("客户")) { intent = "crm.customer.create"; entities.customer = { name: t.includes("ramesh") ? "Ramesh" : "Demo Customer", confidence: 0.94 }; entities.visit = { services: ["maintenance wash"], amount_minor: 80000, currency: "INR", confidence: 0.88 }; }
  if (t.includes("ambiguous") || t.includes("两个") || t.includes("unclear")) confidence = 0.62;
  return understanding({ intent, confidence, entities, missing: confidence < 0.75 ? ["selection"] : [], needs_confirmation: confidence < 0.75, transcript, language: locale.split("-")[0], model: "mock-intent-1" });
}

function mockAsset(text, language, voice, format) {
  const asset_id = `ast_${sha256(`${text}:${language}:${voice}:${format}`).slice(0, 20)}`;
  const mime_type = format === "wav" ? "audio/wav" : format === "ogg" ? "audio/ogg" : "audio/mpeg";
  return { asset_id, url: `/v1/assets/${asset_id}`, mime_type, duration_ms: Math.max(300, text.length * 65), expires_at: new Date(Date.now() + 86400000).toISOString(), voice, provider: "mock", model: "mock-tts-1", status: "ready", data_base64: Buffer.from(`MOCK_TTS:${text}`).toString("base64") };
}
