import assert from "node:assert/strict";
import test from "node:test";
import {
  GetBucketLocationCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  createObjectStorage,
  MemoryObjectStorage,
  persistAudioAsset,
  persistInputAudio,
  S3ObjectStorage,
} from "../src/object-storage.ts";
import { MAX_STORED_AUDIO_BYTES } from "../src/media-policy.ts";

const env = {
  APP_ENV: "test",
  OBJECT_STORAGE_PROVIDER: "s3",
  OBJECT_STORAGE_BUCKET: "private-audio",
  OBJECT_STORAGE_REGION: "us-east-1",
  OBJECT_STORAGE_PREFIX: "voice-crm",
  OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: "45",
};

test("S3 storage uploads private encrypted audio and returns an OSS-compatible signed download", async () => {
  const commands: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      commands.push(command);
      return {};
    },
  };
  const signed: Array<{
    command: GetObjectCommand;
    options: { expiresIn: number };
  }> = [];
  const storage = new S3ObjectStorage({
    env,
    client,
    signer: async (_client, command, options) => {
      signed.push({ command, options });
      return "https://objects.example.test/signed";
    },
  });
  const providerAsset = {
    asset_id: "ast_01234567890123456789",
    url: "/v1/assets/ast_01234567890123456789",
    mime_type: "audio/mpeg",
    status: "ready",
    data_base64: Buffer.from("private audio bytes").toString("base64"),
  };
  const persisted = await persistAudioAsset(storage, providerAsset, {
    tenantId: "tenant-a",
    kind: "tts",
  });
  const [putCommand] = commands;
  assert.ok(putCommand instanceof PutObjectCommand);
  assert.equal(putCommand.input.Bucket, "private-audio");
  assert.equal(putCommand.input.ServerSideEncryption, "AES256");
  assert.match(putCommand.input.Key ?? "", /^voice-crm\/tenant-a\/tts\/ast_/);
  assert.equal("data_base64" in persisted.asset, false);
  assert.equal("byte_length" in persisted.asset, false);
  assert.equal("sha256" in persisted.asset, false);
  assert.equal(persisted.byte_length, Buffer.byteLength("private audio bytes"));
  assert.match(persisted.sha256, /^[0-9a-f]{64}$/);
  assert.equal(persisted.object_key, putCommand.input.Key);
  assert.equal(
    await storage.downloadUrl(persisted.object_key),
    "https://objects.example.test/signed",
  );
  const [signedRequest] = signed;
  assert.ok(signedRequest);
  assert.ok(signedRequest.command instanceof GetObjectCommand);
  assert.deepEqual(signedRequest.command.input, {
    Bucket: "private-audio",
    Key: persisted.object_key,
  });
  assert.equal("ResponseContentType" in signedRequest.command.input, false);
  assert.deepEqual(signedRequest.options, { expiresIn: 45 });
});

test("production object storage fails closed without S3 configuration", () => {
  assert.throws(
    () =>
      createObjectStorage({
        env: { APP_ENV: "production", OBJECT_STORAGE_PROVIDER: "memory" },
      }),
    /forbidden/,
  );
  assert.throws(
    () =>
      createObjectStorage({
        env: { APP_ENV: "production", OBJECT_STORAGE_PROVIDER: "s3" },
      }),
    /required/,
  );
  assert.throws(
    () =>
      createObjectStorage({
        env: {
          ...env,
          APP_ENV: "production",
          OBJECT_STORAGE_ENDPOINT: "http://objects.example.test",
        },
      }),
    /HTTPS/,
  );
});

test("S3 storage health uses a bucket-location probe compatible with Aliyun OSS", async () => {
  const commands: unknown[] = [];
  const storage = new S3ObjectStorage({
    env,
    client: {
      send: async (command: unknown) => {
        commands.push(command);
        return {};
      },
    },
  });
  assert.deepEqual(await storage.health(), { ready: true, provider: "s3" });
  assert.ok(commands[0] instanceof GetBucketLocationCommand);
});

test("input audio is stored privately without returning its bytes", async () => {
  const commands: unknown[] = [];
  const storage = new S3ObjectStorage({
    env,
    client: {
      send: async (command: unknown) => {
        commands.push(command);
        return {};
      },
    },
  });
  const persisted = await persistInputAudio(
    storage,
    Buffer.from("input audio"),
    {
      tenantId: "tenant-a",
      requestId: "req_01234567890123456789",
      contentType: "audio/wav",
    },
  );
  assert.match(persisted.object_key, /\/input\//);
  assert.equal(persisted.asset.mime_type, "audio/wav");
  const [putCommand] = commands;
  assert.ok(putCommand instanceof PutObjectCommand);
  assert.ok(putCommand.input.Body instanceof Uint8Array);
  assert.equal(Buffer.from(putCommand.input.Body).toString(), "input audio");
  assert.equal("data_base64" in persisted.asset, false);
});

test("every storage adapter rejects audio above the shared lifecycle limit", async () => {
  const oversized = Buffer.alloc(MAX_STORED_AUDIO_BYTES + 1);
  await assert.rejects(
    new MemoryObjectStorage().put({
      key: "tenant-a/tts/oversized.wav",
      body: oversized,
      contentType: "audio/wav",
    }),
    /upload limit/,
  );
  const storage = new S3ObjectStorage({
    env,
    client: { send: async () => assert.fail("oversized audio was uploaded") },
  });
  await assert.rejects(
    storage.put({
      key: "tenant-a/tts/oversized.wav",
      body: oversized,
      contentType: "audio/wav",
    }),
    /upload limit/,
  );
});
