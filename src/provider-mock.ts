import { makeAudioAsset, mimeForFormat, validateTtsText, type ProviderAdapter } from "./provider-common.ts";
import { understanding } from "./contracts.ts";

export function createMockProvider(): ProviderAdapter {
  return {
    name: "mock",
    defaultTtsFormat: "mp3",
    configured: () => true,
    async transcribe(audio, { locale }) {
      const text = audio.toString("utf8").replace(/^MOCK_AUDIO:/, "").trim();
      if (!text || /^silence$/i.test(text)) {
        return { text: "", language: locale.split("-")[0], confidence: 0.01, provider: "mock", model: "mock-asr-1", duration_ms: 10 };
      }
      return { text, language: locale.split("-")[0], confidence: 0.98, provider: "mock", model: "mock-asr-1", duration_ms: 10 };
    },
    async understand(transcript, { locale }) {
      const normalized = transcript.toLowerCase();
      let intent = "crm.search";
      let confidence = 0.91;
      const entities: Record<string, any> = {};
      if (normalized.includes("move") || normalized.includes("stage") || normalized.includes("阶段") || normalized.includes("negotiation")) {
        intent = "crm.deal.update_stage";
        entities.deal = { value: "d1", name: "Acme renewal", confidence: 0.96 };
        entities.stage = { value: "Negotiation", confidence: 0.99 };
      } else if (normalized.includes("ramesh") || normalized.includes("customer") || normalized.includes("客户")) {
        intent = "crm.customer.create";
        entities.customer = { name: normalized.includes("ramesh") ? "Ramesh" : "Demo Customer", confidence: 0.94 };
      }
      if (normalized.includes("ambiguous") || normalized.includes("两个") || normalized.includes("unclear")) confidence = 0.62;
      return understanding({
        intent,
        confidence,
        entities,
        missing: confidence < 0.75 ? ["selection"] : [],
        needs_confirmation: intent !== "crm.search" || confidence < 0.75,
        transcript,
        language: locale.split("-")[0],
        model: "mock-intent-1",
      });
    },
    async synthesize(text, { language = "zh-CN", voice = "default", format = "mp3" }) {
      validateTtsText(text, 5000, "mock");
      return makeAudioAsset(Buffer.from(`MOCK_TTS:${text}`), {
        text, language, voice, format, mimeType: mimeForFormat(format), provider: "mock", model: "mock-tts-1",
      });
    },
  };
}
