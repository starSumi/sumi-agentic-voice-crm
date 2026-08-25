import { Busboy, type BusboyInstance } from "@fastify/busboy";
import type { IncomingHttpHeaders } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_STORED_AUDIO_BYTES } from "./media-policy.ts";

const MAX_METADATA_BYTES = 64 * 1024;

export type MultipartFile = Readonly<{
  data: Buffer;
  content_type: string;
}>;
export type MultipartParts = Readonly<{
  metadata?: string;
  audio?: MultipartFile;
}>;
type MultipartRequest = Readable & { readonly headers: IncomingHttpHeaders };

function multipartError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST" });
}

function payloadTooLarge(limit: number): Error & {
  code: string;
  details: { max_bytes: number };
} {
  return Object.assign(new Error(`request body exceeds ${limit} bytes`), {
    code: "PAYLOAD_TOO_LARGE",
    details: { max_bytes: limit },
  });
}

export async function parseMultipartRequest(
  request: MultipartRequest,
  totalLimit: number,
): Promise<MultipartParts> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string")
    throw multipartError("multipart content-type is required");
  const declaredLength = Number(request.headers["content-length"]);
  if (
    request.headers["content-length"] !== undefined &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
  )
    throw multipartError("content-length is invalid");
  if (declaredLength > totalLimit) throw payloadTooLarge(totalLimit);

  let parser: BusboyInstance;
  try {
    parser = new Busboy({
      headers: { ...request.headers, "content-type": contentType },
      limits: {
        fieldNameSize: 32,
        fieldSize: MAX_METADATA_BYTES,
        fields: 1,
        fileSize: MAX_STORED_AUDIO_BYTES,
        files: 1,
        parts: 2,
        headerPairs: 16,
        headerSize: 8 * 1024,
      },
    });
  } catch (cause) {
    throw multipartError(
      cause instanceof Error ? cause.message : "multipart request is invalid",
    );
  }

  const parts: { metadata?: string; audio?: MultipartFile } = {};
  let violation: Error | undefined;
  let totalBytes = 0;
  const rejectOnce = (error: Error): void => {
    violation ??= error;
  };

  parser.on(
    "field",
    (name, value, nameTruncated, valueTruncated, _encoding, mimeType) => {
      if (
        name !== "metadata" ||
        parts.metadata !== undefined ||
        nameTruncated ||
        valueTruncated ||
        mimeType !== "application/json"
      ) {
        rejectOnce(multipartError("multipart metadata part is invalid"));
        return;
      }
      parts.metadata = value;
    },
  );
  parser.on("file", (name, stream, _filename, _encoding, mimeType) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const accepted = name === "audio" && parts.audio === undefined;
    if (!accepted)
      rejectOnce(multipartError("multipart audio part is invalid"));
    stream.on("limit", () =>
      rejectOnce(payloadTooLarge(MAX_STORED_AUDIO_BYTES)),
    );
    stream.on("data", (chunk: Buffer | Uint8Array | string) => {
      if (!accepted || violation) return;
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      chunks.push(bytes);
    });
    stream.on("end", () => {
      if (!accepted || stream.truncated || violation) return;
      parts.audio = {
        data: Buffer.concat(chunks, length),
        content_type: mimeType || "application/octet-stream",
      };
    });
  });
  parser.on("partsLimit", () =>
    rejectOnce(multipartError("multipart request has too many parts")),
  );
  parser.on("filesLimit", () =>
    rejectOnce(multipartError("multipart request has too many files")),
  );
  parser.on("fieldsLimit", () =>
    rejectOnce(multipartError("multipart request has too many fields")),
  );

  const limiter = new Transform({
    transform(chunk: Buffer | Uint8Array | string, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > totalLimit) callback(payloadTooLarge(totalLimit));
      else callback(null, bytes);
    },
  });
  try {
    await pipeline(request, limiter, parser);
  } catch (cause) {
    if (violation) throw violation;
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "PAYLOAD_TOO_LARGE"
    )
      throw cause;
    throw multipartError(
      cause instanceof Error ? cause.message : "multipart request is invalid",
    );
  }
  if (violation) throw violation;
  if (parts.metadata === undefined || parts.audio === undefined)
    throw multipartError("multipart metadata and audio parts are required");
  return parts;
}
