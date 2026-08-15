import { createDashScopeProvider } from "./provider-dashscope.mjs";
import { createMockProvider } from "./provider-mock.mjs";
import { createOpenAiProvider } from "./provider-openai.mjs";
import { LOCALES, MAX_PROVIDER_TIMEOUT_MS, positiveInteger, upstream } from "./provider-common.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const BUILT_IN_FACTORIES = Object.freeze({
  mock: createMockProvider,
  "openai-compatible": createOpenAiProvider,
  dashscope: createDashScopeProvider,
});

class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 30_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.openUntil = 0;
  }
  async run(operation) {
    if (Date.now() < this.openUntil) throw upstream("provider circuit is open");
    try {
      const result = await operation();
      this.failures = 0;
      this.openUntil = 0;
      return result;
    } catch (error) {
      if (error?.breakerEligible !== false) {
        this.failures += 1;
        if (this.failures >= this.threshold) this.openUntil = Date.now() + this.cooldownMs;
      }
      throw error;
    }
  }
  snapshot() {
    return { state: Date.now() < this.openUntil ? "open" : "closed", failures: this.failures };
  }
}

function providerNames(env) {
  return {
    asr: env.ASR_PROVIDER || "mock",
    intent: env.INTENT_PROVIDER || "mock",
    tts: env.TTS_PROVIDER || "mock",
  };
}

export function createProviderRuntime({
  env = process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  factories = BUILT_IN_FACTORIES,
} = {}) {
  const adapters = new Map(Object.entries(factories).map(([name, factory]) => [name, factory({ env, fetchImpl })]));
  const breakers = new Map();

  function breakerFor(kind, provider) {
    const key = `${kind}:${provider}`;
    if (!breakers.has(key)) breakers.set(key, new CircuitBreaker());
    return breakers.get(key);
  }

  function adapterFor(kind) {
    const name = providerNames(env)[kind];
    const adapter = adapters.get(name);
    if (!adapter || typeof adapter[{ asr: "transcribe", intent: "understand", tts: "synthesize" }[kind]] !== "function") {
      throw upstream(`unsupported ${kind.toUpperCase()} provider: ${name}`);
    }
    return { adapter, name };
  }

  async function timed(kind, provider, operation) {
    const timeoutMs = positiveInteger(env.PROVIDER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "PROVIDER_TIMEOUT_MS", { max: MAX_PROVIDER_TIMEOUT_MS });
    return await breakerFor(kind, provider).run(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try { return await operation(controller.signal); }
      catch (error) {
        if (error?.name === "AbortError") {
          throw Object.assign(new Error(`${kind} provider timed out`), { code: kind === "asr" ? "ASR_TIMEOUT" : "UPSTREAM_UNAVAILABLE" });
        }
        if (error?.code) throw error;
        throw upstream(`${kind} provider failed`, error);
      } finally { clearTimeout(timer); }
    });
  }

  return {
    providerReadiness() {
      const names = providerNames(env);
      const statuses = Object.fromEntries(Object.entries(names).map(([kind, name]) => {
        const adapter = adapters.get(name);
        const configured = Boolean(adapter?.configured?.(kind));
        const circuit = breakerFor(kind, name).snapshot().state;
        return [kind, {
          provider: name,
          ready: configured && circuit !== "open",
          reason: configured ? undefined : "credentials_or_adapter_missing",
          circuit,
        }];
      }));
      return { names, statuses, ready: Object.values(statuses).every(({ ready }) => ready) };
    },
    async transcribe(audio, { locale, contentType = "audio/wav" }) {
      if (!LOCALES.has(locale)) throw Object.assign(new Error("unsupported ASR locale"), { code: "INVALID_REQUEST" });
      const { adapter, name } = adapterFor("asr");
      return await timed("asr", name, (signal) => adapter.transcribe(audio, { locale, contentType, signal }));
    },
    async understand(transcript, { locale }) {
      if (!LOCALES.has(locale)) throw Object.assign(new Error("unsupported intent locale"), { code: "INVALID_REQUEST" });
      const { adapter, name } = adapterFor("intent");
      return await timed("intent", name, (signal) => adapter.understand(transcript, { locale, signal }));
    },
    async synthesize(text, options = {}) {
      const { adapter, name } = adapterFor("tts");
      return await timed("tts", name, (signal) => adapter.synthesize(text, { ...options, signal }));
    },
    ttsDefaultFormat() {
      const { adapter } = adapterFor("tts");
      return adapter.defaultTtsFormat || "mp3";
    },
  };
}

const runtime = createProviderRuntime();

export const providerReadiness = () => runtime.providerReadiness();
export const transcribe = (audio, options) => runtime.transcribe(audio, options);
export const understand = (transcript, options) => runtime.understand(transcript, options);
export const synthesize = (text, options) => runtime.synthesize(text, options);
export const ttsDefaultFormat = () => runtime.ttsDefaultFormat();
