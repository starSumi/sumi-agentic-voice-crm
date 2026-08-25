import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { parseMultipartRequest } from "../src/multipart.ts";

function request(
  boundary: string,
  body: Buffer,
): Readable & { headers: IncomingHttpHeaders } {
  return Object.assign(Readable.from([body]), {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
  });
}

function multipartBody(
  boundary: string,
  audio: Buffer,
  extra = Buffer.alloc(0),
): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{"locale":"en-US"}\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ),
    audio,
    Buffer.from("\r\n"),
    extra,
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

test("streaming multipart parsing preserves boundary-like bytes inside audio", async () => {
  const boundary = "sumi-boundary-001";
  const audio = Buffer.concat([
    Buffer.from("RIFF0000WAVE"),
    Buffer.from(`\0--${boundary}-inside-audio\0`),
  ]);
  const parsed = await parseMultipartRequest(
    request(boundary, multipartBody(boundary, audio)),
    1024 * 1024,
  );
  assert.equal(parsed.metadata, '{"locale":"en-US"}');
  assert.equal(parsed.audio?.content_type, "audio/wav");
  assert.deepEqual(parsed.audio?.data, audio);
});

test("streaming multipart parsing rejects extra and missing parts", async () => {
  const boundary = "sumi-boundary-002";
  const audio = Buffer.from("RIFF0000WAVE");
  const extra = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\nvalue\r\n`,
  );
  await assert.rejects(
    parseMultipartRequest(
      request(boundary, multipartBody(boundary, audio, extra)),
      1024 * 1024,
    ),
    /too many parts/,
  );
  const missing = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{}\r\n--${boundary}--\r\n`,
  );
  await assert.rejects(
    parseMultipartRequest(request(boundary, missing), 1024 * 1024),
    /metadata and audio parts are required/,
  );
});

test("streaming multipart parsing enforces the total request limit", async () => {
  const boundary = "sumi-boundary-003";
  const body = multipartBody(boundary, Buffer.from("RIFF0000WAVE"));
  await assert.rejects(
    parseMultipartRequest(request(boundary, body), body.length - 1),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "PAYLOAD_TOO_LARGE",
  );
});
