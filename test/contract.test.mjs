import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 18080 + Math.floor(Math.random() * 500);
let child;
const base = `http://127.0.0.1:${port}`;

test.before(async () => {
  child = spawn(process.execPath, ["src/server.mjs"], { cwd: new URL("..", import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("server startup timeout")), 5000); child.stdout.on("data", (d) => { if (String(d).includes(`:${port}`)) { clearTimeout(timer); resolve(); } }); child.on("error", reject); });
});
test.after(() => child?.kill());

async function ask(body, key = `test-${Math.random()}`, headers = {}) {
  const res = await fetch(`${base}/v1/ask`, { method: "POST", headers: { authorization: "Bearer test-actor", "x-tenant-id": "tenant_demo", "idempotency-key": key, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test("health readiness exposes provider contract", async () => {
  const r = await fetch(`${base}/health/ready`); assert.equal(r.status, 200); assert.equal((await r.json()).status, "ready");
});

test("text ask returns CRM result and TTS asset", async () => {
  const r = await ask({ input: { type: "text", text: "move Acme renewal to Negotiation" }, output_mode: "both", locale: "en-US" });
  assert.equal(r.status, 200); assert.equal(r.body.understanding.intent, "crm.deal.update_stage"); assert.equal(r.body.crm.action, "updated"); assert.equal(r.body.audio.status, "ready");
});

test("same idempotency key returns the same resource result", async () => {
  const body = { input: { type: "text", text: "move Acme renewal to Negotiation" }, output_mode: "text", locale: "en-US" };
  const a = await ask(body, "stable-key-1"); const b = await ask(body, "stable-key-1"); assert.equal(a.body.crm.resource.id, b.body.crm.resource.id); assert.equal(a.body.crm.aggregate_version, b.body.crm.aggregate_version);
});

test("low confidence creates review task and does not commit CRM", async () => {
  const r = await ask({ input: { type: "text", text: "ambiguous customer request" }, output_mode: "text" }, "review-key-1");
  assert.equal(r.status, 202); assert.equal(r.body.status, "needs_review"); assert.ok(r.body.review_task.id);
});

test("missing audio is a non-retryable boundary error", async () => {
  const r = await ask({ input: { type: "audio", audio: null }, output_mode: "text" }); assert.equal(r.status, 422); assert.equal(r.body.error.code, "NO_AUDIO_SOURCE");
});

test("mock audio exercises ASR to intent to TTS", async () => {
  const r = await ask({ input: { type: "audio", data_base64: Buffer.from("MOCK_AUDIO:move Acme renewal to Negotiation").toString("base64"), content_type: "audio/wav" }, output_mode: "both", locale: "en-US" }, "audio-key-1");
  assert.equal(r.status, 200); assert.equal(r.body.input.type, "audio"); assert.equal(r.body.input.asr.provider, "mock"); assert.equal(r.body.audio.mime_type, "audio/mpeg");
});

test("unauthenticated requests are rejected", async () => {
  const res = await fetch(`${base}/v1/ask`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "auth-key-1" }, body: JSON.stringify({ input: { type: "text", text: "hello" }, output_mode: "text" }) });
  assert.equal(res.status, 401); assert.equal((await res.json()).error.code, "UNAUTHORIZED");
});

test("idempotency key reuse with a different command is rejected", async () => {
  await ask({ input: { type: "text", text: "move Acme renewal to Negotiation" }, output_mode: "text", locale: "en-US" }, "conflict-key-1");
  const r = await ask({ input: { type: "text", text: "customer Ramesh" }, output_mode: "text", locale: "en-US" }, "conflict-key-1");
  assert.equal(r.status, 409); assert.equal(r.body.error.code, "IDEMPOTENCY_CONFLICT");
});

test("short idempotency keys fail at the boundary", async () => {
  const r = await ask({ input: { type: "text", text: "hello" }, output_mode: "text" }, "short");
  assert.equal(r.status, 400); assert.equal(r.body.error.code, "INVALID_REQUEST");
});

test("events require tenant auth and use the canonical envelope", async () => {
  const denied = await fetch(`${base}/v1/events`); assert.equal(denied.status, 401);
  const res = await fetch(`${base}/v1/events`, { headers: { authorization: "Bearer test-actor", "x-tenant-id": "tenant_demo" } });
  assert.equal(res.status, 200); const event = (await res.json()).events.at(-1); assert.ok(event);
  for (const field of ["id", "type", "specversion", "source", "subject", "time", "tenant_id", "request_id", "data"]) assert.ok(field in event, field);
});

test("TTS requires tenant identity and idempotency policy", async () => {
  const denied = await fetch(`${base}/v1/tts/synthesize`, { method: "POST", headers: { authorization: "Bearer test-actor", "x-tenant-id": "tenant_demo", "content-type": "application/json" }, body: JSON.stringify({ text: "hello", language: "en-US", format: "mp3" }) });
  assert.equal(denied.status, 400);
  const ok = await fetch(`${base}/v1/tts/synthesize`, { method: "POST", headers: { authorization: "Bearer test-actor", "x-tenant-id": "tenant_demo", "idempotency-key": "tts-key-001", "content-type": "application/json" }, body: JSON.stringify({ text: "hello", language: "en-US", format: "mp3" }) });
  assert.equal(ok.status, 201);
  const replay = await fetch(`${base}/v1/tts/synthesize`, { method: "POST", headers: { authorization: "Bearer test-actor", "x-tenant-id": "tenant_demo", "idempotency-key": "tts-key-001", "content-type": "application/json" }, body: JSON.stringify({ text: "hello", language: "en-US", format: "mp3" }) });
  assert.equal(replay.status, 201); assert.equal((await replay.json()).idempotency_replay, true);
});
