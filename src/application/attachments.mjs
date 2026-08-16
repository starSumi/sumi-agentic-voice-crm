const ASSET_ID = /^ast_[A-Za-z0-9_-]{8,128}$/;
const MIME_TYPE = /^[a-z][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KINDS = new Set(["audio", "image", "document"]);
const STATUSES = new Set(["pending", "ready", "failed"]);

function invalid(field) {
  throw Object.assign(new TypeError(`invalid attachment ${field}`), {
    code: "INVALID_REQUEST",
  });
}

function optionalString(value, field, { maxLength = 256 } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    invalid(field);
  }
  return value;
}

function safeUrl(value) {
  if (value === undefined) return undefined;
  const url = optionalString(value, "url", { maxLength: 2048 });
  let parsed;
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

function safeTimestamp(value) {
  if (value === undefined) return undefined;
  const timestamp = optionalString(value, "expires_at", { maxLength: 64 });
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    invalid("expires_at");
  }
  return timestamp;
}

function safeOptionalMetadata(value, field) {
  return optionalString(value, field, { maxLength: 128 });
}

/**
 * Builds the transport-safe media reference used between application adapters.
 * Only scalar metadata is projected; bytes, storage keys and auth metadata are
 * deliberately outside this boundary.
 */
export function createAttachmentRef(value, { kind } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("value");

  const assetId = value.asset_id;
  if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) invalid("asset_id");

  const attachmentKind = kind ?? value.kind;
  if (!KINDS.has(attachmentKind)) invalid("kind");

  const mimeType = value.mime_type;
  if (typeof mimeType !== "string" || mimeType.length > 191 || !MIME_TYPE.test(mimeType)) {
    invalid("mime_type");
  }

  const status = value.status;
  if (!STATUSES.has(status)) invalid("status");

  const result = {
    asset_id: assetId,
    kind: attachmentKind,
    mime_type: mimeType,
    status,
  };

  if (value.byte_length !== undefined) {
    if (!Number.isSafeInteger(value.byte_length) || value.byte_length < 0) {
      invalid("byte_length");
    }
    result.byte_length = value.byte_length;
  }
  if (value.sha256 !== undefined) {
    if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) invalid("sha256");
    result.sha256 = value.sha256;
  }

  const expiresAt = safeTimestamp(value.expires_at);
  if (expiresAt !== undefined) result.expires_at = expiresAt;
  const url = safeUrl(value.url);
  if (url !== undefined) result.url = url;

  return Object.freeze(result);
}

/** Keeps the established TTS response shape while dropping provider-private data. */
export function createTtsAsset(value) {
  const ref = createAttachmentRef(value, { kind: "audio" });
  if (ref.url === undefined) invalid("url");

  const result = {
    asset_id: ref.asset_id,
    url: ref.url,
    mime_type: ref.mime_type,
    status: ref.status,
  };
  if (value.duration_ms !== undefined) {
    if (!Number.isSafeInteger(value.duration_ms) || value.duration_ms < 0) {
      invalid("duration_ms");
    }
    result.duration_ms = value.duration_ms;
  }
  if (ref.expires_at !== undefined) result.expires_at = ref.expires_at;
  for (const field of ["voice", "provider", "model"]) {
    const metadata = safeOptionalMetadata(value[field], field);
    if (metadata !== undefined) result[field] = metadata;
  }
  return Object.freeze(result);
}
