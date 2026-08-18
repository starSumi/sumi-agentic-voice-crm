import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function decodeKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

export class DataCipher {
  readonly key: Buffer;

  constructor({ env = process.env, key }: { env?: NodeJS.ProcessEnv; key?: Buffer } = {}) {
    const resolvedKey = key ?? decodeKey(env.DATA_ENCRYPTION_KEY);
    if (!resolvedKey) {
      if (env.APP_ENV === "production" || env.STORE_PROVIDER === "postgres") {
        throw new Error("DATA_ENCRYPTION_KEY is required for production and PostgreSQL storage");
      }
      this.key = createHash("sha256").update("sumi-development-memory-only").digest();
    } else {
      this.key = resolvedKey;
    }
  }

  encrypt(value: unknown, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt<T = unknown>(value: string | undefined, context: string): T | undefined {
    if (!value) return undefined;
    const [version, iv, tag, ciphertext] = String(value).split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("unsupported encrypted data envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8")) as T;
  }
}
