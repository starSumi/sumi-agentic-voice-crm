const APPLICATION_NAMES = new Set([
  "APP_ENV",
  "PORT",
  "PUBLIC_BASE_URL",
  "STORE_PROVIDER",
  "DATA_ENCRYPTION_KEY",
  "ASR_PROVIDER",
  "INTENT_PROVIDER",
  "TTS_PROVIDER",
]);

const APPLICATION_PREFIXES = [
  "ALIYUN_",
  "AUTH_",
  "AWS_",
  "COS_",
  "DASHSCOPE_",
  "DATABASE_",
  "DRILL_",
  "GH_",
  "GITHUB_",
  "METRICS_",
  "OBJECT_STORAGE_",
  "OIDC_",
  "OPENAI_",
  "OSS_",
  "OUTBOX_",
  "PROVIDER_",
  "S3_",
  "TENCENTCLOUD_",
];

const SECRET_NAME = /(?:API_?KEY|ACCESS_KEY|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)/i;

export function isolatedDrillEnv(overrides, base = process.env) {
  const inherited = Object.fromEntries(Object.entries(base).filter(([name]) => (
    !APPLICATION_NAMES.has(name)
    && !APPLICATION_PREFIXES.some((prefix) => name.startsWith(prefix))
    && !SECRET_NAME.test(name)
  )));
  return { ...inherited, ...overrides };
}
