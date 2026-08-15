import assert from "node:assert/strict";
import test from "node:test";
import { validateProductionConfig } from "../src/production-config.mjs";

const production = {
  APP_ENV: "production", STORE_PROVIDER: "postgres", DATABASE_URL: "postgresql://db/app",
  DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"), AUTH_MODE: "oidc",
  OIDC_ISSUER: "https://id.example.test", OIDC_AUDIENCE: "voice-crm", OIDC_JWKS_URI: "https://id.example.test/jwks",
  OIDC_REQUIRED_SCOPE: "crm:write",
  OBJECT_STORAGE_PROVIDER: "s3", OBJECT_STORAGE_BUCKET: "private", OBJECT_STORAGE_REGION: "us-east-1",
  ASR_PROVIDER: "openai-compatible", INTENT_PROVIDER: "openai-compatible", TTS_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-only",
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  METRICS_BEARER_TOKEN: "x".repeat(32), PUBLIC_BASE_URL: "https://voice.example.test",
};

test("production API configuration rejects every development fallback", () => {
  assert.doesNotThrow(() => validateProductionConfig(production));
  for (const [name, value] of [["STORE_PROVIDER", "memory"], ["AUTH_MODE", "development"], ["OBJECT_STORAGE_PROVIDER", "memory"], ["ASR_PROVIDER", "mock"]]) {
    assert.throws(() => validateProductionConfig({ ...production, [name]: value }));
  }
  for (const name of ["OIDC_REQUIRED_SCOPE", "OPENAI_BASE_URL"]) {
    assert.throws(() => validateProductionConfig({ ...production, [name]: "" }), new RegExp(name));
  }
  for (const [name, value] of [["OPENAI_BASE_URL", "http://api.example.test/v1"], ["OBJECT_STORAGE_ENDPOINT", "http://objects.example.test"]]) {
    assert.throws(() => validateProductionConfig({ ...production, [name]: value }), /HTTPS/);
  }
});

test("production outbox configuration is independently fail-closed", () => {
  const outbox = { ...production, OUTBOX_TARGET_URL: "https://events.example.test", OUTBOX_TENANT_IDS: "00000000-0000-4000-8000-000000000001", OUTBOX_HMAC_SECRET: "x".repeat(32) };
  assert.doesNotThrow(() => validateProductionConfig(outbox, { component: "outbox" }));
  assert.throws(() => validateProductionConfig({ ...outbox, OUTBOX_TARGET_URL: "http://events.example.test" }, { component: "outbox" }), /HTTPS/);
  assert.throws(() => validateProductionConfig({ ...outbox, OUTBOX_HMAC_SECRET: "short" }, { component: "outbox" }), /32 characters/);
});
