import { createHash } from "node:crypto";
import {
  GetBucketLocationCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  createAttachmentRef,
  createTtsAsset,
} from "./application/attachments.ts";

type StoragePutInput = {
  key: string;
  body: Uint8Array;
  contentType: string;
  sha256?: string;
  metadata?: Record<string, string>;
};
type StorageObject = { body: Buffer; contentType: string; sha256: string };
type StorageHealth = Readonly<{
  ready: boolean;
  provider: string;
  reason?: string;
}>;
type S3StorageCommand =
  PutObjectCommand | GetObjectCommand | GetBucketLocationCommand;
export type S3ClientPort = {
  send(command: S3StorageCommand): Promise<unknown>;
};
export type S3Signer = (
  client: S3ClientPort,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;
export type ObjectStorage = {
  provider: string;
  put(
    input: StoragePutInput,
  ): Promise<{ key: string; byte_length: number; sha256: string }>;
  downloadUrl(key: string): Promise<string>;
  get(key: string): Promise<{
    body: Buffer;
    content_type?: string;
    byte_length: number;
    sha256: string;
  }>;
  health(): Promise<StorageHealth>;
  objectKey?: (input: {
    tenantId: string;
    assetId: string;
    kind: string;
    contentType: string;
  }) => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function storageError(
  message: string,
  cause?: unknown,
): Error & { code: string } {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: "UPSTREAM_UNAVAILABLE",
  });
}

function safePart(value: unknown): string {
  const normalized = String(value).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!normalized || normalized === "." || normalized === "..")
    throw new Error("invalid object storage key component");
  return normalized;
}

function extension(contentType: string): string {
  return (
    { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg" }[
      contentType
    ] ?? "bin"
  );
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function checksumBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}
const MAX_STORED_AUDIO_BYTES = 25 * 1024 * 1024;

function hasByteArrayTransform(
  value: unknown,
): value is { transformToByteArray(): Promise<Uint8Array> } {
  return isRecord(value) && typeof value.transformToByteArray === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function chunkBytes(chunk: unknown): Buffer {
  if (typeof chunk === "string" || chunk instanceof Uint8Array)
    return Buffer.from(chunk);
  if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk));
  throw storageError("stored audio body yielded an invalid chunk");
}

async function bodyBytes(
  body: unknown,
  declaredLength?: number,
): Promise<Buffer> {
  if (
    Number.isSafeInteger(declaredLength) &&
    declaredLength !== undefined &&
    declaredLength > MAX_STORED_AUDIO_BYTES
  ) {
    throw storageError("stored audio exceeds the download limit");
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array)
    return Buffer.from(body);
  if (hasByteArrayTransform(body)) {
    const bytes = Buffer.from(await body.transformToByteArray());
    if (bytes.length > MAX_STORED_AUDIO_BYTES)
      throw storageError("stored audio exceeds the download limit");
    return bytes;
  }
  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of body) {
      const bytes = chunkBytes(chunk);
      length += bytes.length;
      if (length > MAX_STORED_AUDIO_BYTES)
        throw storageError("stored audio exceeds the download limit");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, length);
  }
  throw storageError("stored audio body is unavailable");
}

export class MemoryObjectStorage {
  readonly provider = "memory";
  readonly objects = new Map<string, StorageObject>();
  async put({ key, body, contentType, sha256 }: StoragePutInput) {
    const bytes = Buffer.from(body);
    const digest = sha256 ?? sha256Hex(bytes);
    this.objects.set(key, { body: bytes, contentType, sha256: digest });
    return { key, byte_length: bytes.length, sha256: digest };
  }
  async downloadUrl(key: string): Promise<string> {
    return `/v1/assets/${encodeURIComponent(key.split("/").at(-1)?.split(".")[0] ?? "")}`;
  }
  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) throw storageError("stored audio is unavailable");
    return {
      body: Buffer.from(object.body),
      content_type: object.contentType,
      byte_length: object.body.length,
      sha256: object.sha256,
    };
  }
  async health() {
    return { ready: true, provider: this.provider };
  }
}

export class S3ObjectStorage {
  readonly provider = "s3";
  readonly bucket: string;
  readonly prefix: string;
  readonly expiresIn: number;
  readonly kmsKeyId: string | undefined;
  readonly client: S3ClientPort;
  readonly signer: S3Signer;
  constructor({
    env = process.env,
    client,
    signer,
  }: {
    env?: NodeJS.ProcessEnv;
    client?: S3ClientPort;
    signer?: S3Signer;
  } = {}) {
    this.bucket = env.OBJECT_STORAGE_BUCKET ?? "";
    this.prefix = (env.OBJECT_STORAGE_PREFIX || "voice-crm").replace(
      /^\/+|\/+$/g,
      "",
    );
    this.expiresIn = Number(env.OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS || 60);
    this.kmsKeyId = env.OBJECT_STORAGE_KMS_KEY_ID;
    if (!this.bucket || !env.OBJECT_STORAGE_REGION)
      throw new Error(
        "OBJECT_STORAGE_BUCKET and OBJECT_STORAGE_REGION are required for S3 storage",
      );
    if (
      env.APP_ENV === "production" &&
      env.OBJECT_STORAGE_ENDPOINT &&
      new URL(env.OBJECT_STORAGE_ENDPOINT).protocol !== "https:"
    )
      throw new Error("OBJECT_STORAGE_ENDPOINT must use HTTPS in production");
    if (
      !Number.isInteger(this.expiresIn) ||
      this.expiresIn < 15 ||
      this.expiresIn > 900
    )
      throw new Error(
        "OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS must be between 15 and 900",
      );
    this.client =
      client ??
      new S3Client({
        region: env.OBJECT_STORAGE_REGION,
        endpoint: env.OBJECT_STORAGE_ENDPOINT || undefined,
        forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE === "true",
      });
    this.signer =
      signer ??
      (async (signingClient, command, options) => {
        if (!(signingClient instanceof S3Client)) {
          throw new TypeError(
            "an injected S3 client requires an injected signer",
          );
        }
        return await getSignedUrl(signingClient, command, options);
      });
  }

  async put({
    key,
    body,
    contentType,
    sha256,
    metadata = {},
  }: StoragePutInput) {
    const bytes = Buffer.from(body);
    const digest = sha256 ?? sha256Hex(bytes);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          ContentLength: bytes.length,
          ChecksumSHA256: checksumBase64(digest),
          Metadata: { ...metadata, sha256: digest },
          ServerSideEncryption: this.kmsKeyId ? "aws:kms" : "AES256",
          SSEKMSKeyId: this.kmsKeyId || undefined,
        }),
      );
      return { key, byte_length: bytes.length, sha256: digest };
    } catch (error) {
      throw storageError("object upload failed", error);
    }
  }

  async downloadUrl(key: string): Promise<string> {
    try {
      return await this.signer(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: this.expiresIn },
      );
    } catch (error) {
      throw storageError("object download signing failed", error);
    }
  }

  async get(key: string) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      if (!isRecord(response))
        throw storageError("object download response is invalid");
      const body = await bodyBytes(
        response.Body,
        typeof response.ContentLength === "number"
          ? response.ContentLength
          : undefined,
      );
      return {
        body,
        content_type:
          typeof response.ContentType === "string"
            ? response.ContentType
            : undefined,
        byte_length: body.length,
        sha256: sha256Hex(body),
      };
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "UPSTREAM_UNAVAILABLE") throw error;
      throw storageError("object download failed", error);
    }
  }

  async health() {
    try {
      await this.client.send(
        new GetBucketLocationCommand({ Bucket: this.bucket }),
      );
      return { ready: true, provider: this.provider };
    } catch (error: unknown) {
      return {
        ready: false,
        provider: this.provider,
        reason:
          isRecord(error) && typeof error.name === "string"
            ? error.name
            : "bucket_location_failed",
      };
    }
  }

  objectKey({
    tenantId,
    assetId,
    kind,
    contentType,
  }: {
    tenantId: string;
    assetId: string;
    kind: string;
    contentType: string;
  }): string {
    return [
      this.prefix,
      safePart(tenantId),
      safePart(kind),
      `${safePart(assetId)}.${extension(contentType)}`,
    ]
      .filter(Boolean)
      .join("/");
  }
}

export function createObjectStorage({
  env = process.env,
  client,
  signer,
}: {
  env?: NodeJS.ProcessEnv;
  client?: S3ClientPort;
  signer?: S3Signer;
} = {}): ObjectStorage {
  const provider =
    env.OBJECT_STORAGE_PROVIDER ||
    (env.APP_ENV === "production" ? "s3" : "memory");
  if (provider === "memory") {
    if (env.APP_ENV === "production")
      throw new Error(
        "OBJECT_STORAGE_PROVIDER=memory is forbidden when APP_ENV=production",
      );
    return new MemoryObjectStorage();
  }
  if (provider === "s3") return new S3ObjectStorage({ env, client, signer });
  throw new Error(`unsupported OBJECT_STORAGE_PROVIDER: ${provider}`);
}

export async function persistAudioAsset(
  storage: ObjectStorage,
  providerAsset: unknown,
  { tenantId, kind = "tts" }: { tenantId: string; kind?: string },
) {
  if (!isRecord(providerAsset))
    throw storageError("audio provider returned an invalid asset");
  const encoded = providerAsset.data_base64;
  if (!encoded) {
    if (storage.provider === "s3")
      throw storageError("audio provider returned no bytes for object storage");
    const asset = createTtsAsset(providerAsset);
    return {
      asset,
      attachment_ref: createAttachmentRef(asset, { kind: "audio" }),
      object_key: undefined,
    };
  }
  if (typeof encoded !== "string")
    throw storageError("audio provider returned invalid bytes");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw storageError("audio provider returned empty bytes");
  const assetId = providerAsset.asset_id;
  const contentType = providerAsset.mime_type;
  if (typeof assetId !== "string" || typeof contentType !== "string") {
    throw storageError("audio provider returned incomplete asset metadata");
  }
  const digest =
    typeof providerAsset.sha256 === "string"
      ? providerAsset.sha256
      : sha256Hex(bytes);
  const key =
    typeof storage.objectKey === "function"
      ? storage.objectKey({ tenantId, assetId, kind, contentType })
      : `${safePart(tenantId)}/${safePart(kind)}/${safePart(assetId)}.${extension(contentType)}`;
  const stored = await storage.put({
    key,
    body: bytes,
    contentType,
    sha256: digest,
    metadata: { tenant: safePart(tenantId), kind },
  });
  const asset = createTtsAsset(providerAsset);
  return {
    asset,
    attachment_ref: createAttachmentRef(
      {
        ...asset,
        byte_length: stored.byte_length,
        sha256: stored.sha256,
      },
      { kind: "audio" },
    ),
    object_key: stored.key,
    byte_length: stored.byte_length,
    sha256: stored.sha256,
  };
}

export async function persistInputAudio(
  storage: ObjectStorage,
  bytes: Uint8Array,
  {
    tenantId,
    requestId,
    contentType,
  }: { tenantId: string; requestId: string; contentType: string },
) {
  const body = Buffer.from(bytes);
  if (!body.length) throw storageError("input audio is empty");
  const digest = sha256Hex(body);
  const assetId = `ast_${digest.slice(0, 20)}`;
  const key =
    typeof storage.objectKey === "function"
      ? storage.objectKey({ tenantId, assetId, kind: "input", contentType })
      : `${safePart(tenantId)}/input/${assetId}.${extension(contentType)}`;
  const stored = await storage.put({
    key,
    body,
    contentType,
    sha256: digest,
    metadata: {
      tenant: safePart(tenantId),
      kind: "input",
      request: safePart(requestId),
    },
  });
  const asset = {
    asset_id: assetId,
    mime_type: contentType,
    status: "ready",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
  return {
    asset,
    attachment_ref: createAttachmentRef(
      {
        ...asset,
        byte_length: stored.byte_length,
        sha256: stored.sha256,
      },
      { kind: "audio" },
    ),
    object_key: stored.key,
    byte_length: stored.byte_length,
    sha256: stored.sha256,
  };
}
