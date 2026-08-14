import { sha256, understanding } from "./contracts.mjs";

export async function transcribe(audio, { locale }) {
  const text = audio.toString("utf8").replace(/^MOCK_AUDIO:/, "").trim();
  if (!text || /^silence$/i.test(text)) return { text: "", language: locale?.split("-")[0] ?? "und", confidence: 0.01, provider: "mock", model: "mock-asr-1", duration_ms: 10 };
  return { text, language: locale?.split("-")[0] ?? "zh", confidence: 0.98, provider: "mock", model: "mock-asr-1", duration_ms: 10 };
}

export async function understand(transcript, { locale }) {
  const t = transcript.toLowerCase();
  let intent = "crm.search";
  let confidence = 0.91;
  const entities = {};
  if (t.includes("move") || t.includes("stage") || t.includes("阶段") || t.includes("negotiation")) {
    intent = "crm.deal.update_stage";
    entities.deal = { value: "d1", name: "Acme renewal", confidence: 0.96 };
    entities.stage = { value: "Negotiation", confidence: 0.99 };
  } else if (t.includes("ramesh") || t.includes("customer") || t.includes("客户")) {
    intent = "crm.customer.create";
    entities.customer = { name: t.includes("ramesh") ? "Ramesh" : "Demo Customer", confidence: 0.94 };
    entities.visit = { services: ["maintenance wash"], amount_minor: 80000, currency: "INR", confidence: 0.88 };
  }
  if (t.includes("ambiguous") || t.includes("两个") || t.includes("unclear")) confidence = 0.62;
  return understanding({ intent, confidence, entities, missing: confidence < 0.75 ? ["selection"] : [], needs_confirmation: confidence < 0.75, transcript, language: locale?.split("-")[0] ?? "zh" });
}

export async function synthesize(text, { language = "zh-CN", voice = "default", format = "mp3" }) {
  const asset_id = `ast_${sha256(`${text}:${language}:${voice}:${format}`).slice(0, 20)}`;
  const mime_type = format === "wav" ? "audio/wav" : format === "ogg" ? "audio/ogg" : "audio/mpeg";
  return { asset_id, url: `/v1/assets/${asset_id}`, mime_type, duration_ms: Math.max(300, text.length * 65), expires_at: new Date(Date.now() + 86400000).toISOString(), voice, provider: "mock", model: "mock-tts-1", status: "ready" };
}
