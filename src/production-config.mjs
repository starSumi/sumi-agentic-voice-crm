function requireValue(env, name) {
  if (!env[name]) throw new Error(`${name} is required in production`);
}

function requireHttps(env, name) {
  requireValue(env, name);
  let url;
  try { url = new URL(env[name]); }
  catch { throw new Error(`${name} must be a valid HTTPS URL in production`); }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS in production`);
}

function requirePositiveInteger(env, name, max) {
  if (env[name] === undefined || env[name] === "") return;
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value <= 0 || (max !== undefined && value > max)) {
    const suffix = max === undefined ? "" : ` no greater than ${max}`;
    throw new Error(`${name} must be a positive integer${suffix} in production`);
  }
}

function selectedName(env, names) {
  return names.find((name) => env[name]);
}

function requireOneOf(env, names) {
  const name = selectedName(env, names);
  if (!name) throw new Error(`${names.join(" or ")} is required in production`);
  return name;
}

function requireHttpsOneOf(env, names) {
  const name = requireOneOf(env, names);
  requireHttps(env, name);
  return name;
}

export function validateProductionConfig(env = process.env, { component = "api" } = {}) {
  if (env.APP_ENV !== "production") return;
  if (env.STORE_PROVIDER !== "postgres") throw new Error("STORE_PROVIDER=postgres is required in production");
  requireValue(env, "DATABASE_URL");
  requireValue(env, "DATA_ENCRYPTION_KEY");
  if (component === "outbox") {
    requireValue(env, "OUTBOX_TENANT_IDS");
    requireValue(env, "OUTBOX_HMAC_SECRET");
    requireHttps(env, "OUTBOX_TARGET_URL");
    if (env.OUTBOX_HMAC_SECRET.length < 32) throw new Error("OUTBOX_HMAC_SECRET must contain at least 32 characters");
    return;
  }
  if (env.AUTH_MODE !== "oidc") throw new Error("AUTH_MODE=oidc is required in production");
  requirePositiveInteger(env, "PROVIDER_TIMEOUT_MS", 120_000);
  for (const name of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_REQUIRED_SCOPE", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_REGION", "METRICS_BEARER_TOKEN"]) requireValue(env, name);
  for (const name of ["OIDC_JWKS_URI", "PUBLIC_BASE_URL"]) requireHttps(env, name);
  if (env.OBJECT_STORAGE_PROVIDER !== "s3") throw new Error("OBJECT_STORAGE_PROVIDER=s3 is required in production");
  if (env.OBJECT_STORAGE_ENDPOINT) requireHttps(env, "OBJECT_STORAGE_ENDPOINT");
  const supportedProviders = new Set(["openai-compatible", "dashscope"]);
  for (const name of ["ASR_PROVIDER", "INTENT_PROVIDER", "TTS_PROVIDER"]) {
    if (!supportedProviders.has(env[name])) throw new Error(`${name} must be openai-compatible or dashscope in production`);
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
  if (env.METRICS_BEARER_TOKEN.length < 32) throw new Error("METRICS_BEARER_TOKEN must contain at least 32 characters");
}
