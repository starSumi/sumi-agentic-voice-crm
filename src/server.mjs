import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  AskService,
  createAttachmentRef,
  normalizeAskCommand,
  normalizeReviewCommand,
  normalizeTtsCommand,
  ReviewService,
  TtsService,
} from "./application/index.mjs";
import { createRequestContext, createRuntime } from "./composition-root.mjs";
import { ERROR_CODES, errorEnvelope, requestId, validateAudioInput, validateIdempotencyKey, validateTextAsk } from "./contracts.mjs";
import { validateEvent, validateProtocol } from "./protocol-validation.mjs";
import { persistAudioAsset, persistInputAudio } from "./object-storage.mjs";
import { DEFAULT_AUDIO_OUTPUT_MODE, DEFAULT_LOCALE, REQUEST_BODY_LIMITS, REVIEW_ID_PATTERN } from "./protocol-policy.mjs";

function payloadTooLarge(limit) {
  return Object.assign(new Error("request body exceeds " + limit + " bytes"), {
    code: "PAYLOAD_TOO_LARGE",
    details: { max_bytes: limit },
  });
}

export async function readRequestBody(req, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("request body limit must be a positive integer");
  const declaredLength = Number(req.headers?.["content-length"]);
  if (Number.isSafeInteger(declaredLength) && declaredLength >= 0 && declaredLength > maxBytes) throw payloadTooLarge(maxBytes);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw payloadTooLarge(maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

export function createApp({ runtime: suppliedRuntime, runtimeFactory = createRuntime } = {}) {
  const runtime = suppliedRuntime ?? runtimeFactory();
  const { store, authenticate, objectStorage, observability } = runtime;
  const providers = runtime.providers;
  const { providerReadiness } = providers;
  let draining = false;
  const json = (res, status, body) => { res.statusCode = status; res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); };
  const askService = new AskService({
    beginInteraction: (args) => store.beginInteraction(args),
    checkpointInteraction: (args) => store.checkpointInteraction(args),
    completeInteraction: ({ outcome, ...args }) => store.completeInteraction({
      ...args,
      http_status: outcome === "review_required" ? 202 : 200,
    }),
    failInteraction: (args) => store.failInteraction({
      ...args,
      http_status: ERROR_CODES[args.error_code][0],
    }),
    createReview: (args) => store.createReview(args),
    executeCrm: (args) => store.execute(args),
    recordInputAsset: (args) => store.recordInputAsset(args),
    recordTts: (...args) => store.recordTts(...args),
    transcribe: (...args) => providers.transcribe(...args),
    understand: (...args) => providers.understand(...args),
    synthesize: (...args) => providers.synthesize(...args),
    ttsDefaultFormat: () => providers.ttsDefaultFormat(),
    persistInputAudio: (...args) => persistInputAudio(objectStorage, ...args),
    persistAudioAsset: (...args) => persistAudioAsset(objectStorage, ...args),
    validateResponse: validateProtocol,
    intentProviderName: runtime.env?.INTENT_PROVIDER || "mock",
    intentProviderKind: runtime.env?.INTENT_PROVIDER || "unknown",
    asrProviderKind: runtime.env?.ASR_PROVIDER || "unknown",
    ttsProviderKind: runtime.env?.TTS_PROVIDER || "unknown",
    storageKind: runtime.objectStorage?.provider || "unknown",
    databaseKind: runtime.env?.STORE_PROVIDER === "postgres" ? "postgresql" : "memory",
    tracer: runtime.tracer,
  });
  const ttsService = new TtsService({
    replayTts: (...args) => store.replayTts(...args),
    recordTts: (...args) => store.recordTts(...args),
    synthesize: (...args) => providers.synthesize(...args),
    persistAudioAsset: (...args) => persistAudioAsset(objectStorage, ...args),
    validateResponse: validateProtocol,
    ttsProviderKind: runtime.env?.TTS_PROVIDER || "unknown",
    storageKind: runtime.objectStorage?.provider || "unknown",
    databaseKind: runtime.env?.STORE_PROVIDER === "postgres" ? "postgresql" : "memory",
    tracer: runtime.tracer,
  });
  const reviewService = new ReviewService({
    decideReview: typeof store.decideReview === "function"
      ? (args) => store.decideReview(args)
      : undefined,
    validateResponse: validateProtocol,
    databaseKind: runtime.env?.STORE_PROVIDER === "postgres" ? "postgresql" : "memory",
    tracer: runtime.tracer,
  });

  async function runApplication(name, context, service, command) {
    const tracer = runtime.tracer;
    if (typeof tracer?.startSpan !== "function") return service.execute(context, command);
    const span = tracer.startSpan(name, {
      parent: context.traceparent,
      signal: context.signal,
      attributes: { "app.operation": name.slice("application.".length) },
    });
    const serviceContext = createRequestContext({
      ...context,
      traceparent: span.context.traceparent,
    });
    try {
      const outcome = await service.execute(serviceContext, command);
      span.end({ status: "ok", attributes: { "app.result": outcome.kind?.includes("review") ? "needs_review" : "completed" } });
      return outcome;
    } catch (error) {
      span.end({ status: "error", error, attributes: { "app.result": "failed" } });
      throw error;
    }
  }

  function parseMultipart(buf, type) {
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type)?.[1] ?? /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type)?.[2]; if (!boundary) throw Object.assign(new Error("multipart boundary is required"), { code: "INVALID_REQUEST" });
    const out = {}; for (const part of buf.toString("binary").split(`--${boundary}`).slice(1, -1)) { const i = part.indexOf("\r\n\r\n"); if (i < 0) continue; const head = part.slice(0, i); const payload = part.slice(i + 4).replace(/\r\n$/, ""); const name = /name="([^"]+)"/i.exec(head)?.[1]; if (!name) continue; out[name] = /filename=/i.test(head) ? { data: Buffer.from(payload, "binary"), content_type: /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? "application/octet-stream" } : payload; } return out;
  }
  async function authenticateContext(req, res, rid) {
    const identity = await authenticate(new Headers(req.headers));
    return createRequestContext({ request_id: rid, traceparent: res.getHeader("traceparent"), identity });
  }
  async function ask(req, res, rid) {
    const context = await authenticateContext(req, res, rid);
    const key = validateIdempotencyKey(req.headers["idempotency-key"]);
    const multipart = req.headers["content-type"]?.startsWith("multipart/form-data");
    const raw = await readRequestBody(
      req,
      multipart ? REQUEST_BODY_LIMITS.askMultipart : REQUEST_BODY_LIMITS.askJson,
    );
    let input;
    let outputMode = "text";
    let locale = DEFAULT_LOCALE;
    let conversationId;
    if (multipart) {
      const parts = parseMultipart(raw, req.headers["content-type"]);
      let metadata;
      try {
        metadata = JSON.parse(parts.metadata ?? "{}");
      } catch {
        throw Object.assign(new Error("metadata must be JSON"), { code: "INVALID_REQUEST" });
      }
      const parsed = validateProtocol("MultipartAskMetadata", {
        ...metadata,
        output_mode: metadata.output_mode ?? DEFAULT_AUDIO_OUTPUT_MODE,
      });
      outputMode = parsed.output_mode;
      locale = parsed.locale ?? DEFAULT_LOCALE;
      conversationId = parsed.conversation_id;
      input = validateAudioInput({
        data: parts.audio?.data,
        content_type: parts.audio?.content_type,
        locale,
        output_mode: outputMode,
        env: runtime.env,
      });
    } else {
      const parsed = validateProtocol(
        "AskRequest",
        JSON.parse(raw.toString("utf8") || "{}"),
      );
      conversationId = parsed.conversation_id;
      if (parsed.input?.type === "audio") {
        input = validateAudioInput({
          data: parsed.input.data_base64
            ? Buffer.from(parsed.input.data_base64, "base64")
            : Buffer.alloc(0),
          content_type: parsed.input.content_type ?? "audio/wav",
          locale: parsed.locale ?? locale,
          output_mode: parsed.output_mode ?? "text",
          env: runtime.env,
        });
      } else {
        input = validateTextAsk(parsed);
      }
      outputMode = input.output_mode;
      locale = input.locale;
    }
    const outcome = await runApplication("application.ask", context, askService, normalizeAskCommand({
      idempotency_key: key,
      input,
      locale,
      output_mode: outputMode,
      conversation_id: conversationId,
    }));
    return json(res, outcome.response.status === "needs_review" ? 202 : 200, outcome.response);
  }
  async function tts(req, res, rid) {
    const context = await authenticateContext(req, res, rid);
    const key = validateIdempotencyKey(req.headers["idempotency-key"]);
    const parsed = validateProtocol(
      "TtsRequest",
      JSON.parse((await readRequestBody(req, REQUEST_BODY_LIMITS.ttsJson)).toString("utf8") || "{}"),
    );
    const outcome = await runApplication("application.tts", context, ttsService, normalizeTtsCommand({
      idempotency_key: key,
      ...parsed,
    }));
    return json(res, 201, outcome.response);
  }
  async function reviewDecision(req, res, rid) {
    const context = await authenticateContext(req, res, rid);
    const key = validateIdempotencyKey(req.headers["idempotency-key"]);
    const reviewId = decodeURIComponent(req.url.slice("/v1/reviews/".length, -"/decision".length));
    if (!REVIEW_ID_PATTERN.test(reviewId)) throw Object.assign(new Error("review id is outside the published contract"), { code: "INVALID_REQUEST" });
    const parsed = validateProtocol(
      "ReviewDecisionRequest",
      JSON.parse((await readRequestBody(req, REQUEST_BODY_LIMITS.reviewJson)).toString("utf8") || "{}"),
    );
    const outcome = await runApplication("application.review", context, reviewService, normalizeReviewCommand({
      idempotency_key: key,
      review_id: reviewId,
      ...parsed,
    }));
    return json(res, 200, outcome.response);
  }
const server = createHttpServer(async (req, res) => {
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
      const providerStatus = providerReadiness();
      const ready = !draining && database.ready && objects.ready && providerStatus.ready;
      return json(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", dependencies: { database, objects, providers: providerStatus.statuses }, request_id: rid });
    }
    if (req.method === "GET" && req.url === "/metrics") {
      if (!observability.authorizeMetrics(req.headers.authorization)) throw Object.assign(new Error("metrics authentication required"), { code: "UNAUTHORIZED" });
      res.statusCode = 200; res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8"); return res.end(observability.renderMetrics());
    }
    if (req.method === "GET" && req.url === "/v1/events") {
      const { identity } = await authenticateContext(req, res, rid);
      const events = await store.events(identity.tenant_id, identity.actor_id);
      return json(res, 200, { events: events.filter((event) => validateEvent(event).tenant_id === identity.tenant_id), request_id: rid });
    }
    if (req.method === "POST" && req.url === "/v1/ask") return await ask(req, res, rid);
    if (req.method === "POST" && req.url === "/v1/tts/synthesize") return await tts(req, res, rid);
    if (req.method === "POST" && req.url?.startsWith("/v1/reviews/") && req.url.endsWith("/decision")) return await reviewDecision(req, res, rid);
    if (req.method === "GET" && req.url?.startsWith("/v1/assets/")) {
      const { identity } = await authenticateContext(req, res, rid);
      const contentRequest = req.url.endsWith("/content");
      const encodedAssetId = contentRequest
        ? req.url.slice(11, -"/content".length)
        : req.url.slice(11);
      const assetId = decodeURIComponent(encodedAssetId);
      if (!/^ast_[A-Za-z0-9_-]{8,128}$/.test(assetId)) throw Object.assign(new Error("invalid asset id"), { code: "INVALID_REQUEST" });
      const asset = await store.assetFor(identity.tenant_id, assetId);
      if (!asset) throw Object.assign(new Error("asset not found"), { code: "FORBIDDEN" });
      if (typeof asset.mime_type !== "string" || !asset.mime_type.startsWith("audio/")) {
        throw Object.assign(new Error("asset media type is unavailable"), { code: "UNSUPPORTED_MEDIA" });
      }
      const objectKey = await store.objectKeyFor?.(identity.tenant_id, assetId);
      if (contentRequest) {
        if (!objectKey || typeof objectStorage.get !== "function") {
          throw Object.assign(new Error("asset content is unavailable"), { code: "UPSTREAM_UNAVAILABLE" });
        }
        const stored = await objectStorage.get(objectKey);
        res.statusCode = 200;
        res.setHeader("content-type", asset.mime_type);
        res.setHeader("content-length", stored.body.length);
        res.setHeader("cache-control", "private, no-store");
        res.setHeader("x-content-type-options", "nosniff");
        return res.end(stored.body);
      }
      const attachment = createAttachmentRef({
        ...asset,
        kind: "audio",
        url: `/v1/assets/${assetId}/content`,
      });
      return json(res, 200, validateProtocol("AttachmentRef", attachment));
    }
    return json(res, 404, validateProtocol("ErrorEnvelope", errorEnvelope("INVALID_REQUEST", "route not found", rid)));
  } catch (error) {
    errorCode = ERROR_CODES[error.code] ? error.code : "INVALID_REQUEST";
    const status = ERROR_CODES[errorCode]?.[0] ?? 400;
    const details = error?.details && typeof error.details === "object" ? error.details : {};
    return json(res, status, validateProtocol("ErrorEnvelope", errorEnvelope(errorCode, error.message, rid, details)));
  }
});
let shutdownPromise;
async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  draining = true;
  shutdownPromise = new Promise((resolve, reject) => {
    if (!server.listening) {
      return runtime.close().then(resolve, reject);
    }
    server.close(async (error) => {
      if (error) return reject(error);
      try { await runtime.close(); resolve(); } catch (closeError) { reject(closeError); }
    });
  });
  return shutdownPromise;
}
return Object.freeze({
  server,
  runtime,
  get draining() { return draining; },
  listen(...args) { return server.listen(...args); },
  close: shutdown,
});
}

export const createServer = createApp;

async function main() {
  const port = Number(process.env.PORT || 8080);
  const app = createApp();
  app.listen(port, () => console.log(`sumi-agentic-voice-crm listening on :${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => app.close().catch((error) => { console.error(error); process.exitCode = 1; }));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
