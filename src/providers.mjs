import { createDashScopeProvider } from "./provider-dashscope.mjs";
import { createMockProvider } from "./provider-mock.mjs";
import { createOpenAiProvider } from "./provider-openai.mjs";
import { LOCALES, MAX_PROVIDER_TIMEOUT_MS, positiveInteger, upstream } from "./provider-common.mjs";
import { createControlEngine } from "./control/index.mjs";

const DEFAULT_SOFT_TIMEOUT_MS = 10_000;
const DEFAULT_HARD_GRACE_MS = 2_000;
const BUILT_IN_FACTORIES = Object.freeze({
  mock: createMockProvider,
  "openai-compatible": createOpenAiProvider,
  dashscope: createDashScopeProvider,
});

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
  control = createControlEngine(),
} = {}) {
  const adapters = new Map(Object.entries(factories).map(([name, factory]) => [name, factory({ env, fetchImpl })]));

  function breakerFor(kind, provider) {
    return control.breaker(`provider.${kind}.${provider}`, { threshold: 3, cooldownMs: 30_000 });
  }

  function adapterFor(kind) {
    const name = providerNames(env)[kind];
    const adapter = adapters.get(name);
    if (!adapter || typeof adapter[{ asr: "transcribe", intent: "understand", tts: "synthesize" }[kind]] !== "function") {
      throw upstream(`unsupported ${kind.toUpperCase()} provider: ${name}`);
    }
    return { adapter, name };
  }

  async function timed(kind, provider, operation, parentSignal) {
    const softTimeoutMs = positiveInteger(
      env.PROVIDER_SOFT_TIMEOUT_MS ?? env.PROVIDER_TIMEOUT_MS,
      DEFAULT_SOFT_TIMEOUT_MS,
      "PROVIDER_SOFT_TIMEOUT_MS",
      { max: MAX_PROVIDER_TIMEOUT_MS },
    );
    const hardGraceMs = positiveInteger(
      env.PROVIDER_HARD_GRACE_MS,
      DEFAULT_HARD_GRACE_MS,
      "PROVIDER_HARD_GRACE_MS",
      { max: 30_000 },
    );
    try {
      return await control.run(`provider.${kind}.${provider}`, operation, {
        signal: parentSignal,
        softTimeoutMs,
        hardGraceMs,
        label: `${kind} provider`,
        breaker: { threshold: 3, cooldownMs: 30_000 },
      });
    } catch (error) {
      if (error?.name === "StagedTimeoutError" && kind === "asr") error.code = "ASR_TIMEOUT";
      if (error?.code) throw error;
      throw upstream(`${kind} provider failed`, error);
    }
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
          ready: configured && circuit === "closed",
          reason: !configured ? "credentials_or_adapter_missing" : circuit === "closed" ? undefined : "circuit_not_closed",
          circuit,
        }];
      }));
      return { names, statuses, ready: Object.values(statuses).every(({ ready }) => ready) };
    },
    async transcribe(audio, { locale, contentType = "audio/wav", signal } = {}) {
      if (!LOCALES.has(locale)) throw Object.assign(new Error("unsupported ASR locale"), { code: "INVALID_REQUEST" });
      const { adapter, name } = adapterFor("asr");
      return await timed("asr", name, (operationSignal) => adapter.transcribe(audio, { locale, contentType, signal: operationSignal }), signal);
    },
    async understand(transcript, { locale, signal } = {}) {
      if (!LOCALES.has(locale)) throw Object.assign(new Error("unsupported intent locale"), { code: "INVALID_REQUEST" });
      const { adapter, name } = adapterFor("intent");
      return await timed("intent", name, (operationSignal) => adapter.understand(transcript, { locale, signal: operationSignal }), signal);
    },
    async synthesize(text, options = {}) {
      const { adapter, name } = adapterFor("tts");
      return await timed("tts", name, (operationSignal) => adapter.synthesize(text, { ...options, signal: operationSignal }), options.signal);
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
