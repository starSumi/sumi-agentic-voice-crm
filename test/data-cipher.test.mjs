import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { DataCipher } from "../src/data-cipher.mjs";

test("interaction data is authenticated, encrypted and tenant-bound", () => {
  const key = randomBytes(32);
  const cipher = new DataCipher({ key });
  const value = { transcript: "private customer request" };
  const encrypted = cipher.encrypt(value, "tenant-a:transcript");
  assert.doesNotMatch(encrypted, /private customer request/);
  assert.deepEqual(cipher.decrypt(encrypted, "tenant-a:transcript"), value);
  assert.throws(() => cipher.decrypt(encrypted, "tenant-b:transcript"));
});

test("durable storage fails closed without a production data key", () => {
  assert.throws(() => new DataCipher({ env: { APP_ENV: "production" } }), /DATA_ENCRYPTION_KEY/);
  assert.throws(() => new DataCipher({ env: { STORE_PROVIDER: "postgres" } }), /DATA_ENCRYPTION_KEY/);
  assert.throws(() => new DataCipher({ env: { DATA_ENCRYPTION_KEY: "not-a-32-byte-key" } }), /32-byte/);
});
