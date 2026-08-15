import assert from "node:assert/strict";
import test from "node:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createObjectStorage, persistAudioAsset, persistInputAudio, S3ObjectStorage } from "../src/object-storage.mjs";

const env = {
  APP_ENV: "test",
  OBJECT_STORAGE_PROVIDER: "s3",
  OBJECT_STORAGE_BUCKET: "private-audio",
  OBJECT_STORAGE_REGION: "us-east-1",
  OBJECT_STORAGE_PREFIX: "voice-crm",
  OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: "45",
};

test("S3 storage uploads private encrypted audio and returns a short-lived signed download", async () => {
  const commands = [];
  const client = { send: async (command) => { commands.push(command); return {}; } };
  const signed = [];
  const storage = new S3ObjectStorage({ env, client, signer: async (_client, command, options) => { signed.push({ command, options }); return "https://objects.example.test/signed"; } });
  const providerAsset = {
    asset_id: "ast_01234567890123456789",
    url: "/v1/assets/ast_01234567890123456789",
    mime_type: "audio/mpeg",
    status: "ready",
    data_base64: Buffer.from("private audio bytes").toString("base64"),
  };
  const persisted = await persistAudioAsset(storage, providerAsset, { tenantId: "tenant-a", kind: "tts" });
  assert.ok(commands[0] instanceof PutObjectCommand);
  assert.equal(commands[0].input.Bucket, "private-audio");
  assert.equal(commands[0].input.ServerSideEncryption, "AES256");
  assert.match(commands[0].input.Key, /^voice-crm\/tenant-a\/tts\/ast_/);
  assert.equal("data_base64" in persisted.asset, false);
  assert.equal("byte_length" in persisted.asset, false);
  assert.equal("sha256" in persisted.asset, false);
  assert.equal(persisted.byte_length, Buffer.byteLength("private audio bytes"));
  assert.match(persisted.sha256, /^[0-9a-f]{64}$/);
  assert.equal(persisted.object_key, commands[0].input.Key);
  assert.equal(await storage.downloadUrl(persisted.object_key, { contentType: "audio/mpeg" }), "https://objects.example.test/signed");
  assert.ok(signed[0].command instanceof GetObjectCommand);
  assert.deepEqual(signed[0].options, { expiresIn: 45 });
});

test("production object storage fails closed without S3 configuration", () => {
  assert.throws(() => createObjectStorage({ env: { APP_ENV: "production", OBJECT_STORAGE_PROVIDER: "memory" } }), /forbidden/);
  assert.throws(() => createObjectStorage({ env: { APP_ENV: "production", OBJECT_STORAGE_PROVIDER: "s3" } }), /required/);
  assert.throws(() => createObjectStorage({ env: { ...env, APP_ENV: "production", OBJECT_STORAGE_ENDPOINT: "http://objects.example.test" } }), /HTTPS/);
});

test("input audio is stored privately without returning its bytes", async () => {
  const commands = [];
  const storage = new S3ObjectStorage({ env, client: { send: async (command) => { commands.push(command); return {}; } } });
  const persisted = await persistInputAudio(storage, Buffer.from("input audio"), {
    tenantId: "tenant-a",
    requestId: "req_01234567890123456789",
    contentType: "audio/wav",
  });
  assert.match(persisted.object_key, /\/input\//);
  assert.equal(persisted.asset.mime_type, "audio/wav");
  assert.equal(commands[0].input.Body.toString(), "input audio");
  assert.equal("data_base64" in persisted.asset, false);
});
