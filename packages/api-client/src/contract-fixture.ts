import type { AskData, SynthesizeData } from "./api";
import type { AskRequest } from "./protocol";

const text: AskRequest = {
  input: { type: "text", text: "把 Acme 商机推进到方案阶段" },
  output_mode: "both",
  locale: "zh-CN",
};

const audio: AskRequest = {
  input: {
    type: "audio",
    data_base64: "TU9DS19BVURJTzpoZWxsbw==",
    content_type: "audio/wav",
  },
  output_mode: "text",
  locale: "zh-CN",
};

export const contractFixtures: {
  asks: Array<AskData["body"]>;
  tts: SynthesizeData["body"];
} = {
  asks: [text, audio],
  tts: { text: "处理完成", language: "zh-CN", format: "mp3" },
};
