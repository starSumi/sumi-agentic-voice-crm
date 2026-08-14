import { createServer } from "node:http";
import { CrmStore } from "./store.mjs";
import { assertTenant, ERROR_CODES, errorEnvelope, requestId, sha256, validateAudioInput, validateIdempotencyKey, validateTextAsk } from "./contracts.mjs";
import { synthesize, transcribe, understand } from "./providers.mjs";

const port = Number(process.env.PORT || 8080); const store = new CrmStore();
const json = (res, status, body) => { res.statusCode = status; res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); };
async function body(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); }
function parseMultipart(buf, type) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type)?.[1] ?? /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type)?.[2]; if (!boundary) throw Object.assign(new Error("multipart boundary is required"), { code: "INVALID_REQUEST" });
  const out = {}; for (const part of buf.toString("binary").split(`--${boundary}`).slice(1, -1)) { const i = part.indexOf("\r\n\r\n"); if (i < 0) continue; const head = part.slice(0, i); const payload = part.slice(i + 4).replace(/\r\n$/, ""); const name = /name="([^"]+)"/i.exec(head)?.[1]; if (!name) continue; out[name] = /filename=/i.test(head) ? { data: Buffer.from(payload, "binary"), content_type: /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? "application/octet-stream" } : payload; } return out;
}
async function ask(req, res, rid) {
  const identity = assertTenant(new Headers(req.headers)); const key = validateIdempotencyKey(req.headers["idempotency-key"]); const raw = await body(req); let input, output_mode = "text", locale = "zh-CN";
  if (req.headers["content-type"]?.startsWith("multipart/form-data")) { const p = parseMultipart(raw, req.headers["content-type"]); let meta; try { meta = JSON.parse(p.metadata ?? "{}"); } catch { throw Object.assign(new Error("metadata must be JSON"), { code: "INVALID_REQUEST" }); } output_mode = meta.output_mode ?? "both"; locale = meta.locale ?? locale; input = validateAudioInput({ data: p.audio?.data, content_type: p.audio?.content_type, locale, output_mode }); }
  else { const parsed = JSON.parse(raw.toString("utf8") || "{}"); if (parsed.input?.type === "audio") { const data = parsed.input.data_base64 ? Buffer.from(parsed.input.data_base64, "base64") : Buffer.alloc(0); input = validateAudioInput({ data, content_type: parsed.input.content_type ?? "audio/wav", locale: parsed.locale ?? locale, output_mode: parsed.output_mode ?? "text" }); output_mode = input.output_mode; locale = input.locale; } else { input = validateTextAsk(parsed); output_mode = input.output_mode; locale = input.locale; } }
  const transcriptResult = input.type === "audio" ? await transcribe(input.data, { locale }) : { text: input.text, language: locale.split("-")[0], confidence: 1, provider: "direct", model: "none", duration_ms: 0 };
  if (!transcriptResult.text.trim()) throw Object.assign(new Error("no speech detected"), { code: "EMPTY_TRANSCRIPT" });
  const u = await understand(transcriptResult.text, { locale });
  const base = { request_id: rid, status: u.needs_confirmation ? "needs_review" : "completed", input: { type: input.type, transcript: transcriptResult.text, language: transcriptResult.language, asr: transcriptResult }, understanding: u, answer: { text: u.intent === "crm.deal.update_stage" ? "已更新商机阶段。" : "已解析请求，正在处理。", language: locale } };
  if (u.needs_confirmation) { base.review_task = store.createReview({ ...identity, request_id: rid, understanding: u }); return json(res, 202, base); }
  base.crm = store.execute({ ...identity, idempotency_key: key, intent: u.intent, entities: u.entities, request_id: rid });
  if (output_mode === "audio" || output_mode === "both") base.audio = await synthesize(base.answer.text, { language: locale, format: "mp3" });
  return json(res, 200, base);
}
async function tts(req, res, rid) {
  const identity = assertTenant(new Headers(req.headers)); const key = validateIdempotencyKey(req.headers["idempotency-key"]); const parsed = JSON.parse((await body(req)).toString("utf8") || "{}");
  if (typeof parsed.text !== "string" || !parsed.text.trim() || parsed.text.length > 5000) throw Object.assign(new Error("text is required and must be <=5000 characters"), { code: "INVALID_REQUEST" });
  if (!parsed.language || !["zh-CN", "en-US", "hi-IN", "te-IN"].includes(parsed.language)) throw Object.assign(new Error("unsupported language"), { code: "INVALID_REQUEST" });
  if (!parsed.format || !["mp3", "wav", "ogg"].includes(parsed.format)) throw Object.assign(new Error("format must be mp3, wav or ogg"), { code: "INVALID_REQUEST" });
  const fingerprint = sha256(JSON.stringify({ text: parsed.text.trim(), language: parsed.language, voice: parsed.voice ?? "default", format: parsed.format }));
  const replay = store.replayTts(`${identity.tenant_id}:${key}`, fingerprint); if (replay) return json(res, 201, { request_id: rid, ...replay, idempotency_replay: true });
  const result = await synthesize(parsed.text.trim(), parsed); store.recordTts(`${identity.tenant_id}:${key}`, fingerprint, result);
  return json(res, 201, { request_id: rid, ...result });
}
const server = createServer(async (req, res) => { const rid = requestId(); try { if (req.method === "GET" && req.url === "/health/live") return json(res, 200, { status: "ok", service: "sumi-agentic-voice-crm", request_id: rid }); if (req.method === "GET" && req.url === "/health/ready") { const mode = process.env.PROVIDER_MODE || "mock"; return json(res, 200, { status: "ready", mode, providers: { asr: process.env.ASR_PROVIDER || "mock", intent: process.env.INTENT_PROVIDER || "mock", tts: process.env.TTS_PROVIDER || "mock" }, request_id: rid }); } if (req.method === "GET" && req.url === "/v1/events") { const identity = assertTenant(new Headers(req.headers)); return json(res, 200, { events: store.events().filter((e) => e.tenant_id === identity.tenant_id), request_id: rid }); } if (req.method === "POST" && req.url === "/v1/ask") return await ask(req, res, rid); if (req.method === "POST" && req.url === "/v1/tts/synthesize") return await tts(req, res, rid); if (req.method === "GET" && req.url?.startsWith("/v1/assets/")) { assertTenant(new Headers(req.headers)); return json(res, 200, { status: "ready", asset_id: req.url.slice(11), note: "reference mock asset; production uses private object storage" }); } res.statusCode = 404; return json(res, 404, errorEnvelope("INVALID_REQUEST", "route not found", rid)); } catch (e) { const code = e.code ?? "INVALID_REQUEST"; const status = ERROR_CODES[code]?.[0] ?? 400; return json(res, status, errorEnvelope(code, e.message, rid)); } });
server.listen(port, () => console.log(`sumi-agentic-voice-crm listening on :${port}`));
