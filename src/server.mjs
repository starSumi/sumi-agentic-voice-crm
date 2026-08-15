import { createServer } from "node:http";
import { createAuthenticator } from "./auth.mjs";
import { CrmStore } from "./store.mjs";
import { ERROR_CODES, errorEnvelope, requestId, sha256, validateAudioInput, validateIdempotencyKey, validateTextAsk } from "./contracts.mjs";
import { providerReadiness, synthesize, transcribe, ttsDefaultFormat, understand } from "./providers.mjs";
import { createPostgresStore } from "./postgres-store.mjs";
import { validateEvent, validateProtocol } from "./protocol-validation.mjs";
import { createObjectStorage, persistAudioAsset, persistInputAudio } from "./object-storage.mjs";
import { createObservability } from "./observability.mjs";
import { validateProductionConfig } from "./production-config.mjs";

validateProductionConfig();
const port = Number(process.env.PORT || 8080);
const store = process.env.STORE_PROVIDER === "postgres" ? createPostgresStore() : new CrmStore();
const authenticate = createAuthenticator();
const objectStorage = createObjectStorage();
const observability = createObservability();
const json = (res, status, body) => { res.statusCode = status; res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); };
async function body(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); }
function parseMultipart(buf, type) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type)?.[1] ?? /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type)?.[2]; if (!boundary) throw Object.assign(new Error("multipart boundary is required"), { code: "INVALID_REQUEST" });
  const out = {}; for (const part of buf.toString("binary").split(`--${boundary}`).slice(1, -1)) { const i = part.indexOf("\r\n\r\n"); if (i < 0) continue; const head = part.slice(0, i); const payload = part.slice(i + 4).replace(/\r\n$/, ""); const name = /name="([^"]+)"/i.exec(head)?.[1]; if (!name) continue; out[name] = /filename=/i.test(head) ? { data: Buffer.from(payload, "binary"), content_type: /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? "application/octet-stream" } : payload; } return out;
}
async function ask(req, res, rid) {
  const identity = await authenticate(new Headers(req.headers)); const key = validateIdempotencyKey(req.headers["idempotency-key"]); const raw = await body(req); let input, output_mode = "text", locale = "zh-CN";
  if (req.headers["content-type"]?.startsWith("multipart/form-data")) { const p = parseMultipart(raw, req.headers["content-type"]); let meta; try { meta = JSON.parse(p.metadata ?? "{}"); } catch { throw Object.assign(new Error("metadata must be JSON"), { code: "INVALID_REQUEST" }); } output_mode = meta.output_mode ?? "both"; locale = meta.locale ?? locale; input = validateAudioInput({ data: p.audio?.data, content_type: p.audio?.content_type, locale, output_mode }); }
  else { const candidate = JSON.parse(raw.toString("utf8") || "{}"); const parsed = validateProtocol("AskRequest", candidate); if (parsed.input?.type === "audio") { const data = parsed.input.data_base64 ? Buffer.from(parsed.input.data_base64, "base64") : Buffer.alloc(0); input = validateAudioInput({ data, content_type: parsed.input.content_type ?? "audio/wav", locale: parsed.locale ?? locale, output_mode: parsed.output_mode ?? "text" }); output_mode = input.output_mode; locale = input.locale; } else { input = validateTextAsk(parsed); output_mode = input.output_mode; locale = input.locale; } }
  const requestFingerprint = sha256(JSON.stringify({
    input: input.type === "audio" ? { type: input.type, sha256: sha256(input.data), content_type: input.content_type } : { type: input.type, text: input.text },
    locale,
    output_mode,
  }));
  const interaction = await store.beginInteraction({
    ...identity,
    request_id: rid,
    idempotency_key: key,
    request_fingerprint: requestFingerprint,
    input_type: input.type,
    input_payload: input.type === "audio"
      ? { type: input.type, content_type: input.content_type, byte_length: input.data.length, sha256: sha256(input.data), locale, output_mode }
      : { type: input.type, text: input.text, locale, output_mode },
  });
  if (interaction.replay) return json(res, interaction.http_status, interaction.response);

  try {
    if (input.type === "audio") {
      const persistedInput = await persistInputAudio(objectStorage, input.data, { tenantId: identity.tenant_id, requestId: rid, contentType: input.content_type });
      await store.recordInputAsset({ ...identity, request_id: rid, ...persistedInput, asset: persistedInput.asset });
    }
    const asrStarted = Date.now();
    const transcriptResult = input.type === "audio" ? await transcribe(input.data, { locale, contentType: input.content_type }) : { text: input.text, language: locale.split("-")[0], confidence: 1, provider: "direct", model: "none", duration_ms: 0 };
    if (!transcriptResult.text.trim()) throw Object.assign(new Error("no speech detected"), { code: "EMPTY_TRANSCRIPT" });
    await store.checkpointInteraction({
      ...identity, request_id: rid, idempotency_key: key, transcript: transcriptResult,
      provider_invocations: [{ operation: "asr", provider: transcriptResult.provider, model: transcriptResult.model, status: "succeeded" }],
      model_versions: { asr: transcriptResult.model }, latency_ms: { asr: Date.now() - asrStarted },
    });

    const intentStarted = Date.now();
    const u = await understand(transcriptResult.text, { locale });
    await store.checkpointInteraction({
      ...identity, request_id: rid, idempotency_key: key, understanding: u,
      provider_invocations: [{ operation: "intent", provider: process.env.INTENT_PROVIDER || "mock", model: u.model, status: "succeeded" }],
      model_versions: { intent: u.model }, latency_ms: { intent: Date.now() - intentStarted },
    });
    const base = { request_id: rid, status: u.needs_confirmation ? "needs_review" : "completed", input: { type: input.type, transcript: transcriptResult.text, language: transcriptResult.language, asr: transcriptResult }, understanding: u, answer: { text: u.intent === "crm.deal.update_stage" ? "已更新商机阶段。" : "已解析请求，正在处理。", language: locale } };
    if (u.needs_confirmation) {
      base.review_task = await store.createReview({ ...identity, request_id: rid, idempotency_key: key, request_fingerprint: requestFingerprint, understanding: u });
      const response = validateProtocol("ReviewResponse", base);
      await store.completeInteraction({ ...identity, request_id: rid, idempotency_key: key, response, http_status: 202 });
      return json(res, 202, response);
    }
    base.crm = await store.execute({ ...identity, idempotency_key: key, request_fingerprint: requestFingerprint, intent: u.intent, entities: u.entities, request_id: rid });
    if (output_mode === "audio" || output_mode === "both") {
      const ttsFormat = ttsDefaultFormat();
      const audioFingerprint = sha256(JSON.stringify({ text: base.answer.text, language: locale, format: ttsFormat }));
      const audioKey = `${identity.tenant_id}:${key}:audio:${audioFingerprint}`;
      const ttsStarted = Date.now();
      const generated = await synthesize(base.answer.text, { language: locale, format: ttsFormat });
      const persisted = await persistAudioAsset(objectStorage, generated, { tenantId: identity.tenant_id, kind: "tts" });
      base.audio = await store.recordTts(audioKey, audioFingerprint, persisted.asset, { ...identity, request_id: rid, object_key: persisted.object_key, byte_length: persisted.byte_length, sha256: persisted.sha256 });
      await store.checkpointInteraction({
        ...identity, request_id: rid, idempotency_key: key,
        provider_invocations: [{ operation: "tts", provider: generated.provider, model: generated.model, status: "succeeded" }],
        model_versions: { tts: generated.model }, latency_ms: { tts: Date.now() - ttsStarted },
      });
    }
    const response = validateProtocol("AskResponse", base);
    await store.completeInteraction({ ...identity, request_id: rid, idempotency_key: key, response, http_status: 200 });
    return json(res, 200, response);
  } catch (error) {
    const code = error.code ?? "INVALID_REQUEST";
    try { await store.failInteraction({ ...identity, request_id: rid, idempotency_key: key, error_code: code, error_message: error.message, http_status: ERROR_CODES[code]?.[0] ?? 400 }); } catch {}
    throw error;
  }
}
async function tts(req, res, rid) {
  const identity = await authenticate(new Headers(req.headers)); const key = validateIdempotencyKey(req.headers["idempotency-key"]); const parsed = validateProtocol("TtsRequest", JSON.parse((await body(req)).toString("utf8") || "{}"));
  if (typeof parsed.text !== "string" || !parsed.text.trim() || parsed.text.length > 5000) throw Object.assign(new Error("text is required and must be <=5000 characters"), { code: "INVALID_REQUEST" });
  if (!parsed.language || !["zh-CN", "en-US", "hi-IN", "te-IN"].includes(parsed.language)) throw Object.assign(new Error("unsupported language"), { code: "INVALID_REQUEST" });
  if (!parsed.format || !["mp3", "wav", "ogg"].includes(parsed.format)) throw Object.assign(new Error("format must be mp3, wav or ogg"), { code: "INVALID_REQUEST" });
  const fingerprint = sha256(JSON.stringify({ text: parsed.text.trim(), language: parsed.language, voice: parsed.voice ?? "default", format: parsed.format }));
  const replay = await store.replayTts(`${identity.tenant_id}:${key}`, fingerprint); if (replay) return json(res, 201, validateProtocol("TtsSynthesizeResponse", { request_id: rid, asset: replay, idempotency_replay: true }));
  const result = await synthesize(parsed.text.trim(), parsed);
  const persisted = await persistAudioAsset(objectStorage, result, { tenantId: identity.tenant_id, kind: "tts" });
  const stored = await store.recordTts(`${identity.tenant_id}:${key}`, fingerprint, persisted.asset, { ...identity, request_id: rid, object_key: persisted.object_key, byte_length: persisted.byte_length, sha256: persisted.sha256 });
  return json(res, 201, validateProtocol("TtsSynthesizeResponse", { request_id: rid, asset: stored, idempotency_replay: false }));
}
async function reviewDecision(req, res, rid) {
  const identity = await authenticate(new Headers(req.headers));
  const key = validateIdempotencyKey(req.headers["idempotency-key"]);
  const reviewId = decodeURIComponent(req.url.slice("/v1/reviews/".length, -"/decision".length));
  const parsed = JSON.parse((await body(req)).toString("utf8") || "{}");
  if (!( /^rev_[A-Za-z0-9_-]{4,64}$/.test(reviewId) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reviewId) ) || !["approve", "reject"].includes(parsed.decision)) throw Object.assign(new Error("review id and decision are required"), { code: "INVALID_REQUEST" });
  if (typeof store.decideReview !== "function") throw Object.assign(new Error("review decisions require STORE_PROVIDER=postgres"), { code: "UPSTREAM_UNAVAILABLE" });
  const decision = await store.decideReview({ ...identity, review_id: reviewId, decision: parsed.decision, idempotency_key: key, request_id: rid, correction: parsed.correction });
  return json(res, 200, decision);
}
const server = createServer(async (req, res) => {
  const rid = requestId();
  const telemetry = observability.begin(req, rid);
  let errorCode;
  res.setHeader("traceparent", telemetry.traceparent);
  res.setHeader("x-request-id", rid);
  res.once("finish", () => observability.finish(telemetry, res.statusCode, errorCode));
  try {
    if (req.method === "GET" && req.url === "/health/live") return json(res, 200, { status: "ok", service: "sumi-agentic-voice-crm", request_id: rid });
    if (req.method === "GET" && req.url === "/health/ready") {
      const [database, objects] = await Promise.all([store.health(), objectStorage.health()]);
      const providers = providerReadiness();
      const ready = database.ready && objects.ready && providers.ready;
      return json(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", dependencies: { database, objects, providers: providers.statuses }, request_id: rid });
    }
    if (req.method === "GET" && req.url === "/metrics") {
      if (!observability.authorizeMetrics(req.headers.authorization)) throw Object.assign(new Error("metrics authentication required"), { code: "UNAUTHORIZED" });
      res.statusCode = 200; res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8"); return res.end(observability.renderMetrics());
    }
    if (req.method === "GET" && req.url === "/v1/events") {
      const identity = await authenticate(new Headers(req.headers));
      const events = await store.events(identity.tenant_id, identity.actor_id);
      return json(res, 200, { events: events.filter((event) => validateEvent(event).tenant_id === identity.tenant_id), request_id: rid });
    }
    if (req.method === "POST" && req.url === "/v1/ask") return await ask(req, res, rid);
    if (req.method === "POST" && req.url === "/v1/tts/synthesize") return await tts(req, res, rid);
    if (req.method === "POST" && req.url?.startsWith("/v1/reviews/") && req.url.endsWith("/decision")) return await reviewDecision(req, res, rid);
    if (req.method === "GET" && req.url?.startsWith("/v1/assets/")) {
      const identity = await authenticate(new Headers(req.headers));
      const assetId = decodeURIComponent(req.url.slice(11));
      if (!/^ast_[0-9a-f]{20}$/.test(assetId)) throw Object.assign(new Error("invalid asset id"), { code: "INVALID_REQUEST" });
      const asset = await store.assetFor(identity.tenant_id, assetId);
      if (!asset) throw Object.assign(new Error("asset not found"), { code: "FORBIDDEN" });
      const objectKey = await store.objectKeyFor?.(identity.tenant_id, assetId);
      const url = objectKey ? await objectStorage.downloadUrl(objectKey, { contentType: asset.mime_type }) : asset.url;
      return json(res, 200, { ...asset, url });
    }
    return json(res, 404, errorEnvelope("INVALID_REQUEST", "route not found", rid));
  } catch (error) {
    errorCode = error.code ?? "INVALID_REQUEST";
    const status = ERROR_CODES[errorCode]?.[0] ?? 400;
    return json(res, status, errorEnvelope(errorCode, error.message, rid));
  }
});
server.listen(port, () => console.log(`sumi-agentic-voice-crm listening on :${port}`));
