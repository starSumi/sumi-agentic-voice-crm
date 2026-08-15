import { createHash } from "node:crypto";
import { GetBucketLocationCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function storageError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: "UPSTREAM_UNAVAILABLE" });
}

function safePart(value) {
  const normalized = String(value).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!normalized || normalized === "." || normalized === "..") throw new Error("invalid object storage key component");
  return normalized;
}

function extension(contentType) {
  return ({ "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg" })[contentType] ?? "bin";
}

function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function checksumBase64(hex) { return Buffer.from(hex, "hex").toString("base64"); }

export class MemoryObjectStorage {
  constructor() { this.objects = new Map(); this.provider = "memory"; }
  async put({ key, body, contentType, sha256 }) {
    const bytes = Buffer.from(body);
    const digest = sha256 ?? sha256Hex(bytes);
    this.objects.set(key, { body: bytes, contentType, sha256: digest });
    return { key, byte_length: bytes.length, sha256: digest };
  }
  async downloadUrl(key) { return `/v1/assets/${encodeURIComponent(key.split("/").at(-1).split(".")[0])}`; }
  async health() { return { ready: true, provider: this.provider }; }
}

export class S3ObjectStorage {
  constructor({ env = process.env, client, signer = getSignedUrl } = {}) {
    this.provider = "s3";
    this.bucket = env.OBJECT_STORAGE_BUCKET;
    this.prefix = (env.OBJECT_STORAGE_PREFIX || "voice-crm").replace(/^\/+|\/+$/g, "");
    this.expiresIn = Number(env.OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS || 60);
    this.kmsKeyId = env.OBJECT_STORAGE_KMS_KEY_ID;
    if (!this.bucket || !env.OBJECT_STORAGE_REGION) throw new Error("OBJECT_STORAGE_BUCKET and OBJECT_STORAGE_REGION are required for S3 storage");
    if (env.APP_ENV === "production" && env.OBJECT_STORAGE_ENDPOINT && new URL(env.OBJECT_STORAGE_ENDPOINT).protocol !== "https:") throw new Error("OBJECT_STORAGE_ENDPOINT must use HTTPS in production");
    if (!Number.isInteger(this.expiresIn) || this.expiresIn < 15 || this.expiresIn > 900) throw new Error("OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS must be between 15 and 900");
    this.client = client ?? new S3Client({
      region: env.OBJECT_STORAGE_REGION,
      endpoint: env.OBJECT_STORAGE_ENDPOINT || undefined,
      forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE === "true",
    });
    this.signer = signer;
  }

  async put({ key, body, contentType, sha256, metadata = {} }) {
    const bytes = Buffer.from(body);
    const digest = sha256 ?? sha256Hex(bytes);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ContentLength: bytes.length,
        ChecksumSHA256: checksumBase64(digest),
        Metadata: { ...metadata, sha256: digest },
        ServerSideEncryption: this.kmsKeyId ? "aws:kms" : "AES256",
        SSEKMSKeyId: this.kmsKeyId || undefined,
      }));
      return { key, byte_length: bytes.length, sha256: digest };
    } catch (error) {
      throw storageError("object upload failed", error);
    }
  }

  async downloadUrl(key) {
    try {
      return await this.signer(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: this.expiresIn });
    } catch (error) {
      throw storageError("object download signing failed", error);
    }
  }

  async health() {
    try { await this.client.send(new GetBucketLocationCommand({ Bucket: this.bucket })); return { ready: true, provider: this.provider }; }
    catch (error) { return { ready: false, provider: this.provider, reason: error?.name ?? "bucket_location_failed" }; }
  }

  objectKey({ tenantId, assetId, kind, contentType }) {
    return [this.prefix, safePart(tenantId), safePart(kind), `${safePart(assetId)}.${extension(contentType)}`].filter(Boolean).join("/");
  }
}

export function createObjectStorage({ env = process.env, ...options } = {}) {
  const provider = env.OBJECT_STORAGE_PROVIDER || (env.APP_ENV === "production" ? "s3" : "memory");
  if (provider === "memory") {
    if (env.APP_ENV === "production") throw new Error("OBJECT_STORAGE_PROVIDER=memory is forbidden when APP_ENV=production");
    return new MemoryObjectStorage();
  }
  if (provider === "s3") return new S3ObjectStorage({ env, ...options });
  throw new Error(`unsupported OBJECT_STORAGE_PROVIDER: ${provider}`);
}

export async function persistAudioAsset(storage, providerAsset, { tenantId, kind = "tts" }) {
  const encoded = providerAsset.data_base64;
  if (!encoded) {
    if (storage.provider === "s3") throw storageError("audio provider returned no bytes for object storage");
    return { asset: { ...providerAsset }, object_key: undefined };
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw storageError("audio provider returned empty bytes");
  const digest = providerAsset.sha256 ?? sha256Hex(bytes);
  const key = typeof storage.objectKey === "function"
    ? storage.objectKey({ tenantId, assetId: providerAsset.asset_id, kind, contentType: providerAsset.mime_type })
    : `${safePart(tenantId)}/${safePart(kind)}/${safePart(providerAsset.asset_id)}.${extension(providerAsset.mime_type)}`;
  const stored = await storage.put({ key, body: bytes, contentType: providerAsset.mime_type, sha256: digest, metadata: { tenant: safePart(tenantId), kind } });
  const { data_base64: _discarded, object_key: _private, ...asset } = providerAsset;
  return {
    asset,
    object_key: stored.key,
    byte_length: stored.byte_length,
    sha256: stored.sha256,
  };
}

export async function persistInputAudio(storage, bytes, { tenantId, requestId, contentType }) {
  const body = Buffer.from(bytes);
  if (!body.length) throw storageError("input audio is empty");
  const digest = sha256Hex(body);
  const assetId = `ast_${digest.slice(0, 20)}`;
  const key = typeof storage.objectKey === "function"
    ? storage.objectKey({ tenantId, assetId, kind: "input", contentType })
    : `${safePart(tenantId)}/input/${assetId}.${extension(contentType)}`;
  const stored = await storage.put({ key, body, contentType, sha256: digest, metadata: { tenant: safePart(tenantId), kind: "input", request: safePart(requestId) } });
  return {
    asset: {
      asset_id: assetId,
      mime_type: contentType,
      status: "ready",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    },
    object_key: stored.key,
    byte_length: stored.byte_length,
    sha256: stored.sha256,
  };
}
