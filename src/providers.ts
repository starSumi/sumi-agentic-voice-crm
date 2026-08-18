import { createDashScopeProvider } from "./provider-dashscope.ts";
import { createMockProvider } from "./provider-mock.ts";
import { createOpenAiProvider } from "./provider-openai.ts";
import { LOCALES, MAX_PROVIDER_TIMEOUT_MS, positiveInteger, upstream, type ProviderAdapter } from "./provider-common.ts";
import { createControlEngine } from "./control/index.ts";

const DEFAULT_SOFT_TIMEOUT_MS = 10_000;
const DEFAULT_HARD_GRACE_MS = 2_000;
type ProviderEnvironment = Record<string, string | undefined>;
type ProviderFactory = (input: { env: ProviderEnvironment; fetchImpl: (...args: any[]) => Promise<any> }) => ProviderAdapter;
type ProviderControl = {
  breaker(key: string, options?: Record<string, unknown>): { snapshot(): { state: string }; run<T>(operation: () => T | PromiseLike<T>, options?: Record<string, unknown>): Promise<T> };
  run<T>(key: string, operation: (signal: AbortSignal) => T | PromiseLike<T>, options?: Record<string, unknown>): Promise<T>;
};
export type ProviderRuntime = {
  providerReadiness(): Record<string, any>;
  transcribe(audio: Buffer, options?: any): Promise<Record<string, any>>;
  understand(transcript: string, options?: any): Promise<Record<string, any>>;
  synthesize(text: string, options?: any): Promise<Record<string, any>>;
  ttsDefaultFormat(): string;
};
const BUILT_IN_FACTORIES: Readonly<Record<string, ProviderFactory>> = Object.freeze({
  mock: createMockProvider,
  "openai-compatible": createOpenAiProvider,
  dashscope: createDashScopeProvider,
});

function providerNames(env: ProviderEnvironment): Record<"asr" | "intent" | "tts", string> {
  return {
    asr: env.ASR_PROVIDER || "mock",
    intent: env.INTENT_PROVIDER || "mock",
    tts: env.TTS_PROVIDER || "mock",
  };
}

export function createProviderRuntime({
  env = process.env,
  fetchImpl = (url: any, init?: any) => globalThis.fetch(url, init),
  factories = BUILT_IN_FACTORIES,
  control = createControlEngine() as unknown as ProviderControl,
}: { env?: ProviderEnvironment; fetchImpl?: (...args: any[]) => Promise<any>; factories?: Readonly<Record<string, ProviderFactory>>; control?: ProviderControl } = {}): ProviderRuntime {
  const adapters = new Map(Object.entries(factories).map(([name, factory]) => [name, factory({ env, fetchImpl })]));

  function breakerFor(kind: string, provider: string) {
    return control.breaker(`provider.${kind}.${provider}`, { threshold: 3, cooldownMs: 30_000 });
  }

  function adapterFor(kind: "asr" | "intent" | "tts"): { adapter: ProviderAdapter; name: string } {
    const name = providerNames(env)[kind];
    const adapter = adapters.get(name);
    const method = ({ asr: "transcribe", intent: "understand", tts: "synthesize" } as const)[kind];
    if (!adapter || typeof (adapter as any)[method] !== "function") {
      throw upstream(`unsupported ${kind.toUpperCase()} provider: ${name}`);
    }
    return { adapter, name };
  }

  async function timed<T>(kind: string, provider: string, operation: (signal: AbortSignal) => T | PromiseLike<T>, parentSignal?: AbortSignal): Promise<T> {
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
    } catch (error: unknown) {
      const candidate = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : undefined;
      if (candidate?.name === "StagedTimeoutError" && kind === "asr" && candidate) candidate.code = "ASR_TIMEOUT";
      if (candidate?.code) throw error;
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
    async transcribe(audio: Buffer, { locale = "zh-CN", contentType = "audio/wav", signal }: { locale?: string; contentType?: string; signal?: AbortSignal } = {}) {
      if (!LOCALES.has(locale)) throw Object.assign(new Error("unsupported ASR locale"), { code: "INVALID_REQUEST" });
      const { adapter, name } = adapterFor("asr");
      return await timed("asr", name, (operationSignal) => adapter.transcribe(audio, { locale, contentType, signal: operationSignal }), signal);
    },
    async understand(transcript: string, { locale = "zh-CN", signal }: { locale?: string; signal?: AbortSignal } = {}) {
      if (!LOCALES.has(locale)) throw Object.assign(new Error("unsupported intent locale"), { code: "INVALID_REQUEST" });
      const { adapter, name } = adapterFor("intent");
      return await timed("intent", name, (operationSignal) => adapter.understand(transcript, { locale, signal: operationSignal }), signal);
    },
    async synthesize(text: string, options: Record<string, any> = {}) {
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
export const transcribe = (audio: Buffer, options?: any) => runtime.transcribe(audio, options);
export const understand = (transcript: string, options?: any) => runtime.understand(transcript, options);
export const synthesize = (text: string, options?: any) => runtime.synthesize(text, options);
export const ttsDefaultFormat = () => runtime.ttsDefaultFormat();
