import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/u;

function decodeKey(value: string | undefined, name: string): Buffer | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value))
    throw new Error(`${name} must be a base64-encoded 32-byte key`);
  const key = Buffer.from(value, "base64");
  if (
    key.length !== 32 ||
    key.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")
  )
    throw new Error(`${name} must be a base64-encoded 32-byte key`);
  return key;
}

function decodeKeyring(value: string | undefined): ReadonlyMap<string, Buffer> {
  if (!value) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error("DATA_ENCRYPTION_KEYS must be a JSON object", { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("DATA_ENCRYPTION_KEYS must be a JSON object");
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 32)
    throw new Error("DATA_ENCRYPTION_KEYS must contain between 1 and 32 keys");
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of entries) {
    if (!KEY_ID.test(keyId))
      throw new Error("DATA_ENCRYPTION_KEYS contains an invalid key ID");
    if (typeof encoded !== "string")
      throw new Error(`DATA_ENCRYPTION_KEYS.${keyId} must be a base64 key`);
    const key = decodeKey(encoded, `DATA_ENCRYPTION_KEYS.${keyId}`);
    if (!key) throw new Error(`DATA_ENCRYPTION_KEYS.${keyId} is required`);
    keys.set(keyId, key);
  }
  return keys;
}

function decryptEnvelope<T>(
  key: Buffer,
  iv: string,
  tag: string,
  ciphertext: string,
  context: string,
): T {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"),
  ) as T;
}

export class DataCipher {
  readonly #legacyKey: Buffer | undefined;
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #activeKeyId: string | undefined;

  constructor({
    env = process.env,
    key,
  }: { env?: NodeJS.ProcessEnv; key?: Buffer } = {}) {
    if (key && key.length !== 32)
      throw new Error("data encryption key must contain 32 bytes");
    const configuredKeys = key
      ? new Map<string, Buffer>()
      : decodeKeyring(env.DATA_ENCRYPTION_KEYS);
    const activeKeyId = key ? undefined : env.DATA_ENCRYPTION_ACTIVE_KEY_ID;
    if (activeKeyId && !KEY_ID.test(activeKeyId))
      throw new Error("DATA_ENCRYPTION_ACTIVE_KEY_ID is invalid");
    if (configuredKeys.size > 0 && !activeKeyId)
      throw new Error(
        "DATA_ENCRYPTION_ACTIVE_KEY_ID is required with DATA_ENCRYPTION_KEYS",
      );
    if (activeKeyId && !configuredKeys.has(activeKeyId))
      throw new Error(
        "DATA_ENCRYPTION_ACTIVE_KEY_ID must identify a configured key",
      );

    let legacyKey =
      (key ? Buffer.from(key) : undefined) ??
      decodeKey(env.DATA_ENCRYPTION_KEY, "DATA_ENCRYPTION_KEY");
    if (!legacyKey && configuredKeys.size === 0) {
      if (env.APP_ENV === "production" || env.STORE_PROVIDER === "postgres")
        throw new Error(
          "DATA_ENCRYPTION_KEY or DATA_ENCRYPTION_KEYS is required for production and PostgreSQL storage",
        );
      legacyKey = createHash("sha256")
        .update("sumi-development-memory-only")
        .digest();
    }
    this.#legacyKey = legacyKey;
    this.#keys = configuredKeys;
    this.#activeKeyId = activeKeyId;
  }

  encrypt(value: unknown, context: string): string {
    const keyId = this.#activeKeyId;
    const key = keyId ? this.#keys.get(keyId) : this.#legacyKey;
    if (!key) throw new Error("active data encryption key is unavailable");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return [
      keyId ? "v2" : "v1",
      ...(keyId ? [keyId] : []),
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  decrypt<T = unknown>(value: string | undefined, context: string): T | undefined {
    if (!value) return undefined;
    const parts = String(value).split(".");
    if (parts[0] === "v1" && parts.length === 4 && this.#legacyKey)
      return decryptEnvelope<T>(
        this.#legacyKey,
        parts[1],
        parts[2],
        parts[3],
        context,
      );
    if (parts[0] === "v2" && parts.length === 5) {
      const key = this.#keys.get(parts[1]);
      if (!key) throw new Error("encrypted data key is unavailable");
      return decryptEnvelope<T>(key, parts[2], parts[3], parts[4], context);
    }
    throw new Error("unsupported encrypted data envelope");
  }
}
