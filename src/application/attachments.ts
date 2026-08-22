const ASSET_ID = /^ast_[A-Za-z0-9_-]{8,128}$/;
const MIME_TYPE = /^[a-z][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KINDS = new Set(["audio", "image", "document"]);
const STATUSES = new Set(["pending", "ready", "failed"]);

export type AttachmentKind = "audio" | "image" | "document";
export type AttachmentStatus = "pending" | "ready" | "failed";
export type AttachmentRef = Readonly<{
  asset_id: string;
  kind: AttachmentKind;
  mime_type: string;
  status: AttachmentStatus;
  byte_length?: number;
  sha256?: string;
  expires_at?: string;
  url?: string;
}>;
export type TtsAsset = Readonly<{
  asset_id: string;
  url: string;
  mime_type: string;
  status: AttachmentStatus;
  duration_ms?: number;
  expires_at?: string;
  voice?: string;
  provider?: string;
  model?: string;
}>;
type AttachmentInput = Record<string, unknown>;

function invalid(field: string): never {
  throw Object.assign(new TypeError(`invalid attachment ${field}`), {
    code: "INVALID_REQUEST",
  });
}

function optionalString(value: unknown, field: string, { maxLength = 256 }: { maxLength?: number } = {}): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    invalid(field);
  }
  return value;
}

function safeUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const url = optionalString(value, "url", { maxLength: 2048 });
  if (url === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url, "https://attachment.invalid");
  } catch {
    invalid("url");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) invalid("url");
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") invalid("url");
  return url;
}

function safeTimestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = optionalString(value, "expires_at", { maxLength: 64 });
  if (timestamp === undefined) return undefined;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    invalid("expires_at");
  }
  return timestamp;
}

function safeOptionalMetadata(value: unknown, field: string): string | undefined {
  return optionalString(value, field, { maxLength: 128 });
}

/**
 * Builds the transport-safe media reference used between application adapters.
 * Only scalar metadata is projected; bytes, storage keys and auth metadata are
 * deliberately outside this boundary.
 */
export function createAttachmentRef(value: unknown, { kind }: { kind?: AttachmentKind } = {}): AttachmentRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("value");
  const input = value as AttachmentInput;

  const assetId = input.asset_id;
  if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) invalid("asset_id");

  const attachmentKind = (kind ?? input.kind) as AttachmentKind;
  if (!KINDS.has(attachmentKind)) invalid("kind");

  const mimeType = input.mime_type;
  if (typeof mimeType !== "string" || mimeType.length > 191 || !MIME_TYPE.test(mimeType)) {
    invalid("mime_type");
  }

  const status = input.status as AttachmentStatus;
  if (!STATUSES.has(status)) invalid("status");

  const result: {
    asset_id: string;
    kind: AttachmentKind;
    mime_type: string;
    status: AttachmentStatus;
    byte_length?: number;
    sha256?: string;
    expires_at?: string;
    url?: string;
  } = {
    asset_id: assetId,
    kind: attachmentKind,
    mime_type: mimeType,
    status,
  };

  if (input.byte_length !== undefined) {
    if (!Number.isSafeInteger(input.byte_length) || Number(input.byte_length) < 0) {
      invalid("byte_length");
    }
    result.byte_length = Number(input.byte_length);
  }
  if (input.sha256 !== undefined) {
    if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) invalid("sha256");
    result.sha256 = input.sha256;
  }

  const expiresAt = safeTimestamp(input.expires_at);
  if (expiresAt !== undefined) result.expires_at = expiresAt;
  const url = safeUrl(input.url);
  if (url !== undefined) result.url = url;

  return Object.freeze(result);
}

/** Keeps the established TTS response shape while dropping provider-private data. */
export function createTtsAsset(value: unknown): TtsAsset {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("value");
  const input = value as AttachmentInput;
  const ref = createAttachmentRef(value, { kind: "audio" });
  if (ref.url === undefined) invalid("url");

  const result: {
    asset_id: string;
    url: string;
    mime_type: string;
    status: AttachmentStatus;
    duration_ms?: number;
    expires_at?: string;
    voice?: string;
    provider?: string;
    model?: string;
  } = {
    asset_id: ref.asset_id,
    url: ref.url,
    mime_type: ref.mime_type,
    status: ref.status,
  };
  if (input.duration_ms !== undefined) {
    if (!Number.isSafeInteger(input.duration_ms) || Number(input.duration_ms) < 0) {
      invalid("duration_ms");
    }
    result.duration_ms = Number(input.duration_ms);
  }
  if (ref.expires_at !== undefined) result.expires_at = ref.expires_at;
  for (const field of ["voice", "provider", "model"] as const) {
    const metadata = safeOptionalMetadata(input[field], field);
    if (metadata !== undefined) result[field] = metadata;
  }
  return Object.freeze(result);
}
