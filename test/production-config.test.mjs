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
  OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_MODEL: "gpt-4o-test",
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

test("production API configuration supports mixed providers and DashScope aliases", () => {
  const mixed = {
    ...production,
    ASR_PROVIDER: "dashscope",
    INTENT_PROVIDER: "openai-compatible",
    TTS_PROVIDER: "dashscope",
    DASHSCOPE_API_KEY: "dashscope-test-only",
    DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  };
  assert.doesNotThrow(() => validateProductionConfig(mixed));

  const dashscopeOnly = { ...mixed, INTENT_PROVIDER: "dashscope" };
  delete dashscopeOnly.OPENAI_API_KEY;
  delete dashscopeOnly.OPENAI_BASE_URL;
  delete dashscopeOnly.OPENAI_MODEL;
  assert.doesNotThrow(() => validateProductionConfig(dashscopeOnly));

  const aliyunAliases = { ...dashscopeOnly, ALIYUN_BASE_APIKEY: "alias-test-only", ALIYUN_BASE_URL: mixed.DASHSCOPE_BASE_URL };
  delete aliyunAliases.DASHSCOPE_API_KEY;
  delete aliyunAliases.DASHSCOPE_BASE_URL;
  assert.doesNotThrow(() => validateProductionConfig(aliyunAliases));
  assert.throws(() => validateProductionConfig({ ...dashscopeOnly, DASHSCOPE_API_KEY: "", DASHSCOPE_BASE_URL: "" }), /DASHSCOPE_API_KEY or ALIYUN_BASE_APIKEY/);
  assert.throws(() => validateProductionConfig({ ...dashscopeOnly, DASHSCOPE_TTS_MAX_BYTES: "0" }), /positive integer/);
  assert.throws(() => validateProductionConfig({ ...dashscopeOnly, DASHSCOPE_TTS_MAX_BYTES: String(51 * 1024 * 1024) }), /no greater than/);
  assert.throws(() => validateProductionConfig({ ...dashscopeOnly, PROVIDER_TIMEOUT_MS: "120001" }), /no greater than/);
  assert.throws(() => validateProductionConfig({ ...dashscopeOnly, DASHSCOPE_AUDIO_HOST_SUFFIXES: "not-a-domain" }), /DNS suffixes/);
});

test("production outbox configuration is independently fail-closed", () => {
  const outbox = { ...production, OUTBOX_TARGET_URL: "https://events.example.test", OUTBOX_TENANT_IDS: "00000000-0000-4000-8000-000000000001", OUTBOX_HMAC_SECRET: "x".repeat(32) };
  assert.doesNotThrow(() => validateProductionConfig(outbox, { component: "outbox" }));
  assert.throws(() => validateProductionConfig({ ...outbox, OUTBOX_TARGET_URL: "http://events.example.test" }, { component: "outbox" }), /HTTPS/);
  assert.throws(() => validateProductionConfig({ ...outbox, OUTBOX_HMAC_SECRET: "short" }, { component: "outbox" }), /32 characters/);
});
