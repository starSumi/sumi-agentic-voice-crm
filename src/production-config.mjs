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
  for (const name of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_REQUIRED_SCOPE", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_REGION", "OPENAI_API_KEY", "METRICS_BEARER_TOKEN"]) requireValue(env, name);
  for (const name of ["OIDC_JWKS_URI", "OPENAI_BASE_URL", "PUBLIC_BASE_URL"]) requireHttps(env, name);
  if (env.OBJECT_STORAGE_PROVIDER !== "s3") throw new Error("OBJECT_STORAGE_PROVIDER=s3 is required in production");
  if (env.OBJECT_STORAGE_ENDPOINT) requireHttps(env, "OBJECT_STORAGE_ENDPOINT");
  for (const name of ["ASR_PROVIDER", "INTENT_PROVIDER", "TTS_PROVIDER"]) {
    if (env[name] !== "openai-compatible") throw new Error(`${name}=openai-compatible is required in production`);
  }
  if (env.METRICS_BEARER_TOKEN.length < 32) throw new Error("METRICS_BEARER_TOKEN must contain at least 32 characters");
}
