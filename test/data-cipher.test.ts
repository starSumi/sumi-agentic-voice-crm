import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { DataCipher } from "../src/data-cipher.ts";

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
  assert.throws(
    () => new DataCipher({ env: { APP_ENV: "production" } }),
    /DATA_ENCRYPTION_KEY/,
  );
  assert.throws(
    () => new DataCipher({ env: { STORE_PROVIDER: "postgres" } }),
    /DATA_ENCRYPTION_KEY/,
  );
  assert.throws(
    () => new DataCipher({ env: { DATA_ENCRYPTION_KEY: "not-a-32-byte-key" } }),
    /32-byte/,
  );
});

test("versioned data encryption keys rotate without losing old envelopes", () => {
  const oldKey = randomBytes(32).toString("base64");
  const newKey = randomBytes(32).toString("base64");
  const beforeRotation = new DataCipher({
    env: {
      DATA_ENCRYPTION_ACTIVE_KEY_ID: "key_2026_08",
      DATA_ENCRYPTION_KEYS: JSON.stringify({ key_2026_08: oldKey }),
    },
  });
  const oldEnvelope = beforeRotation.encrypt(
    { transcript: "before rotation" },
    "tenant-a:transcript",
  );
  assert.match(oldEnvelope, /^v2\.key_2026_08\./u);

  const afterRotation = new DataCipher({
    env: {
      DATA_ENCRYPTION_ACTIVE_KEY_ID: "key_2026_09",
      DATA_ENCRYPTION_KEYS: JSON.stringify({
        key_2026_08: oldKey,
        key_2026_09: newKey,
      }),
    },
  });
  assert.deepEqual(
    afterRotation.decrypt(oldEnvelope, "tenant-a:transcript"),
    { transcript: "before rotation" },
  );
  assert.match(
    afterRotation.encrypt(
      { transcript: "after rotation" },
      "tenant-a:transcript",
    ),
    /^v2\.key_2026_09\./u,
  );
});

test("versioned key configuration fails closed on missing or unknown active IDs", () => {
  const encoded = randomBytes(32).toString("base64");
  assert.throws(
    () =>
      new DataCipher({
        env: { DATA_ENCRYPTION_KEYS: JSON.stringify({ current: encoded }) },
      }),
    /ACTIVE_KEY_ID is required/,
  );
  assert.throws(
    () =>
      new DataCipher({
        env: {
          DATA_ENCRYPTION_ACTIVE_KEY_ID: "missing",
          DATA_ENCRYPTION_KEYS: JSON.stringify({ current: encoded }),
        },
      }),
    /must identify a configured key/,
  );
});
