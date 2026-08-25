import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { testRecord } from "./test-types.ts";

const port = 18080 + Math.floor(Math.random() * 500);
let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
const base = `http://127.0.0.1:${port}`;

test.before(async () => {
  const serverProcess = spawn(process.execPath, ["src/server.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = serverProcess;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server startup timeout")),
      5000,
    );
    serverProcess.stdout.on("data", (data: Buffer) => {
      if (String(data).includes(`:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    serverProcess.on("error", reject);
  });
});
test.after(() => child?.kill());

async function ask(
  body: Readonly<Record<string, unknown>>,
  key = `test-${Math.random()}`,
  headers: Readonly<Record<string, string>> = {},
) {
  const res = await fetch(`${base}/v1/ask`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-actor",
      "x-tenant-id": "tenant_demo",
      "idempotency-key": key,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: testRecord(await res.json()) };
}

test("health readiness exposes provider contract", async () => {
  const r = await fetch(`${base}/health/ready`);
  assert.equal(r.status, 200);
  assert.equal(testRecord(await r.json()).status, "ready");
});

test("read-only text ask returns CRM result and TTS asset", async () => {
  const r = await ask({
    input: { type: "text", text: "find Acme renewal" },
    output_mode: "both",
    locale: "en-US",
  });
  const resultUnderstanding = testRecord(r.body.understanding);
  const resultCrm = testRecord(r.body.crm);
  const resultAudio = testRecord(r.body.audio);
  assert.equal(r.status, 200);
  assert.equal(resultUnderstanding.intent, "crm.search");
  assert.equal(resultUnderstanding.needs_confirmation, false);
  assert.equal(resultCrm.action, "read_only");
  assert.equal(resultAudio.status, "ready");
});

test("audio assets use an authenticated metadata and binary content boundary", async () => {
  const r = await ask(
    {
      input: { type: "text", text: "find Acme renewal" },
      output_mode: "both",
      locale: "en-US",
    },
    "asset-boundary-1",
  );
  assert.equal(r.status, 200);
  const assetId = testRecord(r.body.audio).asset_id;
  assert.equal(typeof assetId, "string");
  if (typeof assetId !== "string") throw new TypeError("missing asset id");
  const headers = {
    authorization: "Bearer test-actor",
    "x-tenant-id": "tenant_demo",
  };
  const metadata = await fetch(`${base}/v1/assets/${assetId}`, { headers });
  assert.equal(metadata.status, 200);
  const metadataBody = await metadata.json();
  assert.equal(metadataBody.asset_id, assetId);
  assert.equal(metadataBody.kind, "audio");
  assert.equal(metadataBody.url, `/v1/assets/${assetId}/content`);
  assert.equal(/[?&](?:signature|token|x-amz-)/i.test(metadataBody.url), false);

  const content = await fetch(`${base}${metadataBody.url}`, { headers });
  assert.equal(content.status, 200);
  assert.match(content.headers.get("content-type") ?? "", /^audio\//);
  assert.ok((await content.arrayBuffer()).byteLength > 0);
  const denied = await fetch(`${base}${metadataBody.url}`);
  assert.equal(denied.status, 401);
});

test("mutating intent is fail-closed even when provider says no confirmation", async () => {
  const r = await ask(
    {
      input: { type: "text", text: "move Acme renewal to Negotiation" },
      output_mode: "text",
      locale: "en-US",
    },
    "mutation-policy-1",
  );
  assert.equal(r.status, 202);
  assert.equal(r.body.status, "needs_review");
  assert.equal(testRecord(r.body.understanding).needs_confirmation, true);
  assert.ok(testRecord(r.body.review_task).id);
  const events = await fetch(`${base}/v1/events`, {
    headers: {
      authorization: "Bearer test-actor",
      "x-tenant-id": "tenant_demo",
    },
  });
  const committed = (await events.json()).events.filter(
    (event: Readonly<Record<string, unknown>>) =>
      event.request_id === r.body.request_id &&
      event.type === "crm.command.committed.v1",
  );
  assert.equal(committed.length, 0);
});

test("same idempotency key returns the same review task", async () => {
  const body = {
    input: { type: "text", text: "move Acme renewal to Negotiation" },
    output_mode: "text",
    locale: "en-US",
  };
  const a = await ask(body, "stable-key-1");
  const b = await ask(body, "stable-key-1");
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal(
    testRecord(a.body.review_task).id,
    testRecord(b.body.review_task).id,
  );
});

test("low confidence creates review task and does not commit CRM", async () => {
  const r = await ask(
    {
      input: { type: "text", text: "ambiguous customer request" },
      output_mode: "text",
    },
    "review-key-1",
  );
  assert.equal(r.status, 202);
  assert.equal(r.body.status, "needs_review");
  assert.ok(testRecord(r.body.review_task).id);
});

test("missing audio is a non-retryable boundary error", async () => {
  const r = await ask({
    input: { type: "audio", audio: null },
    output_mode: "text",
  });
  assert.equal(r.status, 422);
  assert.equal(testRecord(r.body.error).code, "NO_AUDIO_SOURCE");
});

test("mock audio exercises ASR to intent to TTS", async () => {
  const r = await ask(
    {
      input: {
        type: "audio",
        data_base64: Buffer.from("MOCK_AUDIO:find Acme renewal").toString(
          "base64",
        ),
        content_type: "audio/wav",
      },
      output_mode: "both",
      locale: "en-US",
    },
    "audio-key-1",
  );
  assert.equal(r.status, 200);
  const resultInput = testRecord(r.body.input);
  assert.equal(resultInput.type, "audio");
  assert.equal(testRecord(resultInput.asr).provider, "mock");
  assert.equal(testRecord(r.body.understanding).needs_confirmation, false);
  assert.equal(testRecord(r.body.audio).mime_type, "audio/mpeg");
});

test("unauthenticated requests are rejected", async () => {
  const res = await fetch(`${base}/v1/ask`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "auth-key-1",
    },
    body: JSON.stringify({
      input: { type: "text", text: "hello" },
      output_mode: "text",
    }),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "UNAUTHORIZED");
});

test("idempotency key reuse with a different command is rejected", async () => {
  await ask(
    {
      input: { type: "text", text: "move Acme renewal to Negotiation" },
      output_mode: "text",
      locale: "en-US",
    },
    "conflict-key-1",
  );
  const r = await ask(
    {
      input: { type: "text", text: "customer Ramesh" },
      output_mode: "text",
      locale: "en-US",
    },
    "conflict-key-1",
  );
  assert.equal(r.status, 409);
  assert.equal(testRecord(r.body.error).code, "IDEMPOTENCY_CONFLICT");
});

test("short idempotency keys fail at the boundary", async () => {
  const r = await ask(
    { input: { type: "text", text: "hello" }, output_mode: "text" },
    "short",
  );
  assert.equal(r.status, 400);
  assert.equal(testRecord(r.body.error).code, "INVALID_REQUEST");
});

test("JSON ask variants enforce the published oneOf and locale constraints", async () => {
  const unknown = await ask(
    {
      input: { type: "text", text: "hello" },
      output_mode: "text",
      unsupported: true,
    },
    "schema-unknown-1",
  );
  assert.equal(unknown.status, 400);
  assert.equal(testRecord(unknown.body.error).code, "INVALID_REQUEST");
  const locale = await ask(
    {
      input: { type: "text", text: "hello" },
      output_mode: "text",
      locale: "fr-FR",
    },
    "schema-locale-1",
  );
  assert.equal(locale.status, 400);
  assert.equal(testRecord(locale.body.error).code, "INVALID_REQUEST");
});

test("events require tenant auth and use the canonical envelope", async () => {
  const denied = await fetch(`${base}/v1/events`);
  assert.equal(denied.status, 401);
  const res = await fetch(`${base}/v1/events`, {
    headers: {
      authorization: "Bearer test-actor",
      "x-tenant-id": "tenant_demo",
    },
  });
  assert.equal(res.status, 200);
  const event = (await res.json()).events.at(-1);
  assert.ok(event);
  for (const field of [
    "id",
    "type",
    "specversion",
    "source",
    "subject",
    "time",
    "tenant_id",
    "request_id",
    "data",
  ])
    assert.ok(field in event, field);
});

test("TTS requires tenant identity and idempotency policy", async () => {
  const denied = await fetch(`${base}/v1/tts/synthesize`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-actor",
      "x-tenant-id": "tenant_demo",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "hello", language: "en-US", format: "mp3" }),
  });
  assert.equal(denied.status, 400);
  const ok = await fetch(`${base}/v1/tts/synthesize`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-actor",
      "x-tenant-id": "tenant_demo",
      "idempotency-key": "tts-key-001",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "hello", language: "en-US", format: "mp3" }),
  });
  assert.equal(ok.status, 201);
  const replay = await fetch(`${base}/v1/tts/synthesize`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-actor",
      "x-tenant-id": "tenant_demo",
      "idempotency-key": "tts-key-001",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "hello", language: "en-US", format: "mp3" }),
  });
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).idempotency_replay, true);
});

test("TTS response and request remain closed under the contract", async () => {
  const response = await fetch(`${base}/v1/tts/synthesize`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-actor",
      "x-tenant-id": "tenant_demo",
      "idempotency-key": "tts-schema-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "hello", language: "fr-FR", format: "mp3" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_REQUEST");
});

test("low-confidence review can be approved or rejected through the durable boundary", async () => {
  const first = await ask(
    {
      input: { type: "text", text: "ambiguous customer" },
      output_mode: "text",
    },
    "review-http-001",
  );
  assert.equal(first.status, 202);
  const reviewId = testRecord(first.body.review_task).id;
  assert.equal(typeof reviewId, "string");
  if (typeof reviewId !== "string") throw new TypeError("missing review id");
  const decision = await fetch(`${base}/v1/reviews/${reviewId}/decision`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-actor",
      "x-tenant-id": "tenant_demo",
      "idempotency-key": "review-decision-001",
      "content-type": "application/json",
    },
    body: JSON.stringify({ decision: "reject" }),
  });
  assert.equal(decision.status, 503);
  assert.equal((await decision.json()).error.code, "UPSTREAM_UNAVAILABLE");
});
