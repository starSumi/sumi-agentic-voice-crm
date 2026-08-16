import assert from "node:assert/strict";
import test from "node:test";
import { createAttachmentRef } from "../src/application/index.mjs";
import { MemoryObjectStorage, persistAudioAsset, persistInputAudio } from "../src/object-storage.mjs";

const SHA256 = "a".repeat(64);

test("AttachmentRef is frozen, JSON-safe and projects only public scalar metadata", () => {
  const ref = createAttachmentRef({
    asset_id: "ast_0123456789abcdef",
    kind: "audio",
    mime_type: "audio/wav",
    status: "ready",
    byte_length: 12,
    sha256: SHA256,
    expires_at: "2030-01-01T00:00:00.000Z",
    url: "/v1/assets/ast_0123456789abcdef",
    data_base64: "private-bytes",
    object_key: "tenant/private.wav",
    authorization: "Bearer private",
    metadata: { signature: "private" },
  });

  assert.equal(Object.isFrozen(ref), true);
  assert.deepEqual(ref, {
    asset_id: "ast_0123456789abcdef",
    kind: "audio",
    mime_type: "audio/wav",
    status: "ready",
    byte_length: 12,
    sha256: SHA256,
    expires_at: "2030-01-01T00:00:00.000Z",
    url: "/v1/assets/ast_0123456789abcdef",
  });
  assert.doesNotThrow(() => JSON.stringify(ref));
  assert.equal(JSON.stringify(ref).includes("private"), false);
});

test("AttachmentRef rejects malformed identifiers, MIME, hashes and signed URLs", () => {
  const valid = {
    asset_id: "ast_0123456789abcdef",
    kind: "audio",
    mime_type: "audio/wav",
    status: "ready",
  };
  for (const candidate of [
    { ...valid, asset_id: "../../private" },
    { ...valid, kind: "binary" },
    { ...valid, mime_type: "Audio/WAV" },
    { ...valid, status: "deleted" },
    { ...valid, byte_length: -1 },
    { ...valid, sha256: "not-a-hash" },
    { ...valid, url: "https://objects.invalid/audio?signature=private" },
  ]) {
    assert.throws(() => createAttachmentRef(candidate), (error) => error.code === "INVALID_REQUEST");
  }
});

test("audio persistence returns a safe AttachmentRef without changing the legacy asset", async () => {
  const storage = new MemoryObjectStorage();
  const providerAsset = {
    asset_id: "ast_0123456789abcdef",
    url: "/v1/assets/ast_0123456789abcdef",
    mime_type: "audio/mpeg",
    status: "ready",
    provider: "test",
    authorization: "Bearer private",
    object_key: "tenant/private.mp3",
    data_base64: Buffer.from("tts bytes").toString("base64"),
  };
  const persisted = await persistAudioAsset(storage, providerAsset, {
    tenantId: "tenant-a",
  });

  assert.equal(persisted.asset.kind, undefined);
  assert.equal(persisted.asset.byte_length, undefined);
  assert.equal("authorization" in persisted.asset, false);
  assert.equal("object_key" in persisted.asset, false);
  assert.equal(persisted.attachment_ref.kind, "audio");
  assert.equal(persisted.attachment_ref.byte_length, Buffer.byteLength("tts bytes"));
  assert.equal("data_base64" in persisted.attachment_ref, false);
  assert.equal("object_key" in persisted.attachment_ref, false);

  const input = await persistInputAudio(storage, Buffer.from("input bytes"), {
    tenantId: "tenant-a",
    requestId: "req_012345678901234567890123",
    contentType: "audio/wav",
  });
  assert.equal(input.attachment_ref.kind, "audio");
  assert.equal(input.attachment_ref.mime_type, "audio/wav");
  assert.equal("object_key" in input.attachment_ref, false);
});

test("audio persistence rejects a provider URL containing signed query material", async () => {
  await assert.rejects(
    persistAudioAsset(new MemoryObjectStorage(), {
      asset_id: "ast_0123456789abcdef",
      url: "https://objects.invalid/audio?signature=private",
      mime_type: "audio/mpeg",
      status: "ready",
    }, { tenantId: "tenant-a" }),
    (error) => error.code === "INVALID_REQUEST" && !error.message.includes("private"),
  );
});
