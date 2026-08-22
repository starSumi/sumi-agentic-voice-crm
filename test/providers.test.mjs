import assert from "node:assert/strict";
import test from "node:test";
import { createProviderRuntime } from "../src/providers.ts";

const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)]);
const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(12)]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function dashscopeEnv(overrides = {}) {
  return {
    ASR_PROVIDER: "dashscope",
    INTENT_PROVIDER: "dashscope",
    TTS_PROVIDER: "dashscope",
    DASHSCOPE_API_KEY: "unit-test-key",
    DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    DASHSCOPE_MODEL: "qwen-plus-test",
    PROVIDER_TIMEOUT_MS: "2000",
    ...overrides,
  };
}

function validUnderstanding(extra = {}) {
  return {
    intent: "crm.search",
    confidence: 0.91,
    entities: {},
    missing: [],
    needs_confirmation: false,
    ...extra,
  };
}

test("OpenAI-compatible adapter preserves ASR, Responses JSON schema and bounded TTS", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/audio/transcriptions")) return jsonResponse({ text: "find Acme", language: "en", confidence: 0.95 });
    if (url.endsWith("/responses")) return jsonResponse({ output_text: JSON.stringify(validUnderstanding()) });
    if (url.endsWith("/audio/speech")) {
      const request = JSON.parse(init.body);
      const bytes = request.response_format === "opus" ? ogg : mp3;
      return new Response(bytes, { headers: { "content-type": request.response_format === "opus" ? "audio/ogg" : "audio/mpeg", "content-length": String(bytes.length) } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const env = {
    ASR_PROVIDER: "openai-compatible",
    INTENT_PROVIDER: "openai-compatible",
    TTS_PROVIDER: "openai-compatible",
    OPENAI_API_KEY: "unit-test-key",
    OPENAI_BASE_URL: "https://api.openai.example/v1",
    OPENAI_MODEL: "gpt-test",
    OPENAI_ASR_MODEL: "whisper-test",
    OPENAI_TTS_MODEL: "tts-test",
  };
  const runtime = createProviderRuntime({ env, fetchImpl });

  const transcript = await runtime.transcribe(Buffer.from("audio"), { locale: "en-US", contentType: "audio/mpeg" });
  const intent = await runtime.understand(transcript.text, { locale: "en-US" });
  const asset = await runtime.synthesize("done", { language: "en-US", format: "mp3" });
  const oggAsset = await runtime.synthesize("done", { language: "en-US", format: "ogg" });

  assert.equal(runtime.providerReadiness().ready, true);
  assert.equal(transcript.model, "whisper-test");
  assert.equal(intent.source.model, "gpt-test");
  assert.equal(asset.mime_type, "audio/mpeg");
  assert.equal(asset.voice, "alloy");
  assert.deepEqual(Buffer.from(asset.data_base64, "base64"), mp3);
  assert.equal(oggAsset.mime_type, "audio/ogg");
  assert.deepEqual(Buffer.from(oggAsset.data_base64, "base64"), ogg);
  assert.notEqual(asset.asset_id, oggAsset.asset_id);
  assert.equal(calls[0].init.body.get("model"), "whisper-test");
  assert.equal(calls[0].init.body.get("file").type, "audio/mpeg");
  const responseRequest = JSON.parse(calls[1].init.body);
  assert.equal(responseRequest.text.format.type, "json_schema");
  assert.equal(responseRequest.text.format.strict, true);
  assert.equal(JSON.parse(calls[2].init.body).response_format, "mp3");
  assert.equal(JSON.parse(calls[3].init.body).response_format, "opus");
});

test("DashScope ASR sends the MIME-aware input_audio Data URL", async () => {
  const calls = [];
  const runtime = createProviderRuntime({
    env: dashscopeEnv(),
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ choices: [{ message: { content: "查找客户" } }] });
    },
  });

  const result = await runtime.transcribe(Buffer.from("voice"), { locale: "zh-CN", contentType: "audio/x-wav" });
  const request = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(request.model, "qwen3-asr-flash");
  assert.equal(request.messages[0].content[0].input_audio.data, `data:audio/wav;base64,${Buffer.from("voice").toString("base64")}`);
  assert.equal(result.provider, "dashscope");
  assert.equal(result.text, "查找客户");
});

test("DashScope ASR enforces the encoded 10 MB boundary without opening its circuit", async () => {
  let calls = 0;
  const runtime = createProviderRuntime({
    env: dashscopeEnv(),
    fetchImpl: async () => { calls += 1; return jsonResponse({ choices: [{ message: { content: "ok" } }] }); },
  });
  const prefixBytes = Buffer.byteLength("data:audio/wav;base64,");
  const boundary = Math.floor((10 * 1024 * 1024 - prefixBytes) / 4) * 3;
  await runtime.transcribe(Buffer.alloc(boundary - 1), { locale: "en-US", contentType: "audio/wav" });
  await runtime.transcribe(Buffer.alloc(boundary), { locale: "en-US", contentType: "audio/wav" });
  const oversized = Buffer.alloc(boundary + 1);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() => runtime.transcribe(oversized, { locale: "en-US", contentType: "audio/wav" }), (error) => error.code === "INVALID_REQUEST");
  }
  assert.equal(calls, 2);
  assert.equal(runtime.providerReadiness().statuses.asr.circuit, "closed");
});

test("DashScope intent uses JSON Object mode and validates the CRM schema locally", async () => {
  const calls = [];
  const runtime = createProviderRuntime({
    env: dashscopeEnv(),
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validUnderstanding()) } }] });
    },
  });
  const result = await runtime.understand("find Acme", { locale: "en-US" });
  const request = JSON.parse(calls[0].init.body);
  assert.equal(request.response_format.type, "json_object");
  assert.equal(request.enable_thinking, false);
  assert.equal(result.intent, "crm.search");

  const malformed = createProviderRuntime({
    env: dashscopeEnv(),
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: JSON.stringify(validUnderstanding({ extra: true })) } }] }),
  });
  await assert.rejects(() => malformed.understand("find Acme", { locale: "en-US" }), (error) => error.code === "UPSTREAM_UNAVAILABLE" && /Agent CRM contract/.test(error.message));
});

test("provider 4xx rejections are non-retryable and do not open the circuit", async () => {
  let calls = 0;
  const runtime = createProviderRuntime({
    env: dashscopeEnv(),
    fetchImpl: async () => { calls += 1; return new Response("provider detail must not leak", { status: 400 }); },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(
      () => runtime.understand("find Acme", { locale: "en-US" }),
      (error) => error.code === "PROVIDER_REJECTED" && error.breakerEligible === false && /HTTP 400/.test(error.message),
    );
  }
  assert.equal(calls, 4);
  assert.equal(runtime.providerReadiness().statuses.intent.circuit, "closed");
});

test("DashScope TTS upgrades an official result URL to HTTPS and stores actual WAV bytes", async () => {
  const calls = [];
  const signedUrl = "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav?signature=secret";
  const runtime = createProviderRuntime({
    env: dashscopeEnv(),
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (calls.length === 1) return jsonResponse({ output: { audio: { url: signedUrl } } });
      return new Response(wav, { headers: { "content-type": "audio/x-wav", "content-length": String(wav.length) } });
    },
  });

  const result = await runtime.synthesize("你好", { language: "zh-CN", voice: "default", format: "wav" });
  assert.match(calls[0].url, /\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/);
  assert.equal(JSON.parse(calls[0].init.body).input.voice, "Cherry");
  assert.equal(calls[1].url, signedUrl.replace("http:", "https:"));
  assert.equal(calls[1].init.redirect, "manual");
  assert.equal(result.mime_type, "audio/wav");
  assert.equal(result.url.startsWith("/v1/assets/"), true);
  assert.equal(JSON.stringify(result).includes("signature=secret"), false);
  assert.deepEqual(Buffer.from(result.data_base64, "base64"), wav);
});

test("DashScope TTS prefers bounded inline audio data", async () => {
  let calls = 0;
  const runtime = createProviderRuntime({
    env: dashscopeEnv(),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ output: { audio: { data: wav.toString("base64"), url: "https://evil.example/audio.wav" } } });
    },
  });
  const result = await runtime.synthesize("hello", { language: "en-US", format: "wav" });
  assert.equal(calls, 1);
  assert.equal(result.mime_type, "audio/wav");
});

test("DashScope TTS rejects untrusted result hosts, redirects and oversized audio", async () => {
  for (const scenario of ["host", "redirect", "size"]) {
    let calls = 0;
    const env = dashscopeEnv(scenario === "size" ? { DASHSCOPE_TTS_MAX_BYTES: "8" } : {});
    const runtime = createProviderRuntime({
      env,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          const url = scenario === "host"
            ? "https://evil.example/audio.wav"
            : "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav";
          return jsonResponse({ output: { audio: { url } } });
        }
        if (scenario === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.example/audio.wav" } });
        return new Response(wav, { headers: { "content-type": "audio/wav", "content-length": String(wav.length) } });
      },
    });
    await assert.rejects(() => runtime.synthesize("hello", { language: "en-US", format: "wav" }), (error) => error.code === "UPSTREAM_UNAVAILABLE");
    assert.equal(calls, scenario === "host" ? 1 : 2);
  }
});

test("provider capability preflights reject unsupported TTS locales, long text and oversized JSON", async () => {
  const dashscope = createProviderRuntime({ env: dashscopeEnv(), fetchImpl: async () => { throw new Error("must not fetch"); } });
  await assert.rejects(() => dashscope.synthesize("hello", { language: "hi-IN", format: "wav" }), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(() => dashscope.synthesize("中".repeat(513), { language: "zh-CN", format: "wav" }), (error) => error.code === "INVALID_REQUEST");

  const openai = createProviderRuntime({
    env: {
      ASR_PROVIDER: "mock", INTENT_PROVIDER: "mock", TTS_PROVIDER: "openai-compatible",
      OPENAI_API_KEY: "unit-test-key", OPENAI_BASE_URL: "https://api.openai.example/v1", OPENAI_TTS_MODEL: "tts-test",
    },
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  await assert.rejects(() => openai.synthesize("x".repeat(4097), { language: "en-US", format: "mp3" }), (error) => error.code === "INVALID_REQUEST");

  const malformed = createProviderRuntime({
    env: { ASR_PROVIDER: "mock", INTENT_PROVIDER: "openai-compatible", TTS_PROVIDER: "mock", OPENAI_API_KEY: "unit-test-key", OPENAI_BASE_URL: "https://api.openai.example/v1", OPENAI_MODEL: "gpt-test" },
    fetchImpl: async () => new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024) } }),
  });
  await assert.rejects(() => malformed.understand("find", { locale: "en-US" }), (error) => error.code === "UPSTREAM_UNAVAILABLE" && /1048576-byte limit/.test(error.message));

  let calls = 0;
  const mismatch = createProviderRuntime({
    env: dashscopeEnv(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ output: { audio: { url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.mp3" } } });
      return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
    },
  });
  await assert.rejects(() => mismatch.synthesize("hello", { language: "en-US", format: "wav" }), (error) => error.code === "UPSTREAM_UNAVAILABLE");
});

test("asset identity includes provider, model, voice, format and MIME", async () => {
  const runtime = createProviderRuntime({ env: { ASR_PROVIDER: "mock", INTENT_PROVIDER: "mock", TTS_PROVIDER: "mock" } });
  const first = await runtime.synthesize("same", { language: "en-US", voice: "alloy", format: "mp3" });
  const second = await runtime.synthesize("same", { language: "en-US", voice: "other", format: "mp3" });
  const third = await runtime.synthesize("same", { language: "en-US", voice: "alloy", format: "wav" });
  assert.equal(new Set([first.asset_id, second.asset_id, third.asset_id]).size, 3);
});

test("readiness supports mixed providers and the existing ALIYUN aliases", () => {
  const runtime = createProviderRuntime({
    env: {
      ASR_PROVIDER: "dashscope",
      INTENT_PROVIDER: "openai-compatible",
      TTS_PROVIDER: "mock",
      ALIYUN_BASE_APIKEY: "aliyun-alias-key",
      ALIYUN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      OPENAI_API_KEY: "openai-key",
      OPENAI_MODEL: "gpt-test",
    },
    fetchImpl: async () => { throw new Error("not called"); },
  });
  assert.deepEqual(runtime.providerReadiness().names, { asr: "dashscope", intent: "openai-compatible", tts: "mock" });
  assert.equal(runtime.providerReadiness().ready, true);
  assert.equal(runtime.ttsDefaultFormat(), "mp3");
});
