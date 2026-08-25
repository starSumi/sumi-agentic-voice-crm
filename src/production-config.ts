import { z } from "zod";

type ProductionComponent = "api" | "outbox";

const nonEmptyString = z.string().min(1);
const httpsUrl = z.url().refine((value) => value.startsWith("https://"), {
  message: "HTTPS URL required",
});
const uuid = z.uuid();
const positiveInteger = z.string().regex(/^\d+$/u).transform(Number);

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  const parsed = nonEmptyString.safeParse(value);
  if (!parsed.success) throw new Error(`${name} is required in production`);
  return parsed.data;
}

function requireHttps(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireValue(env, name);
  const parsed = httpsUrl.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${name} must use HTTPS in production`);
  }
  return parsed.data;
}

function requirePositiveInteger(env: NodeJS.ProcessEnv, name: string, max?: number): void {
  if (env[name] === undefined || env[name] === "") return;
  const parsed = positiveInteger.safeParse(env[name]);
  const value = parsed.success ? parsed.data : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || (max !== undefined && value > max)) {
    const suffix = max === undefined ? "" : ` no greater than ${max}`;
    throw new Error(`${name} must be a positive integer${suffix} in production`);
  }
}

function requireUuid(env: NodeJS.ProcessEnv, name: string): void {
  const value = requireValue(env, name);
  if (!uuid.safeParse(value).success) {
    throw new Error(`${name} must be a UUID in production`);
  }
}

function selectedName(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  return names.find((name) => env[name]);
}

function requireOneOf(env: NodeJS.ProcessEnv, names: readonly string[]): string {
  const name = selectedName(env, names);
  if (!name) throw new Error(`${names.join(" or ")} is required in production`);
  return name;
}

function requireHttpsOneOf(env: NodeJS.ProcessEnv, names: readonly string[]): string {
  const name = requireOneOf(env, names);
  requireHttps(env, name);
  return name;
}

export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env, { component = "api" }: { component?: ProductionComponent } = {}): void {
  if (env.APP_ENV !== "production") return;
  if (env.STORE_PROVIDER !== "postgres") throw new Error("STORE_PROVIDER=postgres is required in production");
  requireValue(env, "DATABASE_URL");
  requireValue(env, "DATA_ENCRYPTION_KEY");
  if (component === "outbox") {
    requireValue(env, "OUTBOX_TENANT_IDS");
    requireValue(env, "OUTBOX_HMAC_SECRET");
    requireHttps(env, "OUTBOX_TARGET_URL");
    if (requireValue(env, "OUTBOX_HMAC_SECRET").length < 32) throw new Error("OUTBOX_HMAC_SECRET must contain at least 32 characters");
    return;
  }
  if (env.AUTH_MODE !== "oidc" && env.AUTH_MODE !== "static") throw new Error("AUTH_MODE must be oidc or static in production");
  requirePositiveInteger(env, "PROVIDER_TIMEOUT_MS", 120_000);
  requirePositiveInteger(env, "PROVIDER_SOFT_TIMEOUT_MS", 120_000);
  requirePositiveInteger(env, "PROVIDER_HARD_GRACE_MS", 30_000);
  requirePositiveInteger(env, "INTERACTION_LEASE_MS", 900_000);
  requirePositiveInteger(env, "RUNTIME_TEARDOWN_MS", 30_000);
  for (const name of ["OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_REGION", "METRICS_BEARER_TOKEN"]) requireValue(env, name);
  requireHttps(env, "PUBLIC_BASE_URL");
  if (env.AUTH_MODE === "oidc") {
    for (const name of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_REQUIRED_SCOPE"]) requireValue(env, name);
    requireHttps(env, "OIDC_JWKS_URI");
  } else {
    for (const name of ["AUTH_STATIC_BEARER_TOKEN", "AUTH_STATIC_SUBJECT"]) requireValue(env, name);
    requireUuid(env, "AUTH_STATIC_TENANT_ID");
    if (requireValue(env, "AUTH_STATIC_BEARER_TOKEN").length < 32) throw new Error("AUTH_STATIC_BEARER_TOKEN must contain at least 32 characters");
  }
  if (env.OBJECT_STORAGE_PROVIDER !== "s3") throw new Error("OBJECT_STORAGE_PROVIDER=s3 is required in production");
  if (env.OBJECT_STORAGE_ENDPOINT) requireHttps(env, "OBJECT_STORAGE_ENDPOINT");
  const speechProviders = new Set(["openai-compatible", "dashscope"]);
  const intentProviders = new Set([
    "openai-compatible",
    "dashscope",
    "agent-crm-http",
  ]);
  for (const name of ["ASR_PROVIDER", "TTS_PROVIDER"]) {
    if (!speechProviders.has(env[name] ?? ""))
      throw new Error(`${name} must be openai-compatible or dashscope in production`);
  }
  if (!intentProviders.has(env.INTENT_PROVIDER ?? "")) {
    throw new Error(
      "INTENT_PROVIDER must be openai-compatible, dashscope or agent-crm-http in production",
    );
  }
  const selected = new Set([env.ASR_PROVIDER, env.INTENT_PROVIDER, env.TTS_PROVIDER]);
  if (selected.has("openai-compatible")) {
    requireValue(env, "OPENAI_API_KEY");
    requireHttps(env, "OPENAI_BASE_URL");
    if (env.INTENT_PROVIDER === "openai-compatible") requireValue(env, "OPENAI_MODEL");
    requirePositiveInteger(env, "OPENAI_TTS_MAX_BYTES", 50 * 1024 * 1024);
    requirePositiveInteger(env, "PROVIDER_TTS_MAX_BYTES", 50 * 1024 * 1024);
  }
  if (selected.has("dashscope")) {
    requireOneOf(env, ["DASHSCOPE_API_KEY", "ALIYUN_BASE_APIKEY"]);
    requireHttpsOneOf(env, ["DASHSCOPE_BASE_URL", "ALIYUN_BASE_URL"]);
    const limitName = selectedName(env, ["DASHSCOPE_TTS_MAX_BYTES", "ALIYUN_TTS_MAX_BYTES"]);
    if (limitName) requirePositiveInteger(env, limitName, 50 * 1024 * 1024);
    const suffixes = env.DASHSCOPE_AUDIO_HOST_SUFFIXES || env.ALIYUN_AUDIO_HOST_SUFFIXES;
    if (suffixes && suffixes.split(",").some((item) => !/^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(item.trim()) || !item.includes("."))) {
      throw new Error("DASHSCOPE_AUDIO_HOST_SUFFIXES must contain comma-separated DNS suffixes in production");
    }
  }
  if (env.INTENT_PROVIDER === "agent-crm-http") {
    requireHttps(env, "AGENT_CRM_HTTP_URL");
    requireValue(env, "AGENT_CRM_HTTP_MODEL");
    requireValue(env, "AGENT_CRM_HTTP_CALLER_ID");
  }
  if (requireValue(env, "METRICS_BEARER_TOKEN").length < 32) throw new Error("METRICS_BEARER_TOKEN must contain at least 32 characters");
}
