import { randomBytes, timingSafeEqual } from "node:crypto";
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ERROR_CODES as PROTOCOL_ERROR_CODES } from "./protocol-policy.mjs";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ACTIVE_SPAN = Symbol("active-span");
const OTEL_CONTEXT = Symbol("otel-context");
const SPAN_STATUSES = new Set(["ok", "error", "aborted"]);
const SPAN_NAMES = new Set([
  "http.server",
  "application.ask",
  "application.tts",
  "application.review",
  "provider.asr",
  "provider.intent",
  "provider.tts",
  "storage.object",
  "store.transaction",
  "outbox.publish",
  "runtime.close",
]);
const HTTP_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const ERROR_CODES = new Set(Object.keys(PROTOCOL_ERROR_CODES));
const ENUM_ATTRIBUTES = Object.freeze({
  "app.operation": new Set(["ask", "tts", "review", "unknown"]),
  "app.result": new Set(["completed", "needs_review", "replayed", "failed", "unknown"]),
  "db.system": new Set(["memory", "postgresql", "unknown"]),
  "input.type": new Set(["audio", "text", "unknown"]),
  "output.mode": new Set(["audio", "both", "text", "unknown"]),
  "provider.kind": new Set(["dashscope", "mock", "openai-compatible", "unknown"]),
  "storage.kind": new Set(["memory", "s3", "unknown"]),
});

function nonZero(value, pattern) {
  return pattern.test(value) && !/^0+$/.test(value);
}

/** Parse only the W3C version-00 form supported by this service. */
export function parseTraceparent(value) {
  if (typeof value !== "string") return undefined;
  const match = TRACEPARENT.exec(value.toLowerCase());
  if (!match || !nonZero(match[1], TRACE_ID) || !nonZero(match[2], SPAN_ID)) return undefined;
  return Object.freeze({ trace_id: match[1], span_id: match[2], trace_flags: match[3] });
}

function generatedId(generator, key, bytes, pattern) {
  try {
    const value = String(generator?.[key]?.() ?? "").toLowerCase();
    if (nonZero(value, pattern)) return value;
  } catch {}
  let value;
  do value = randomBytes(bytes).toString("hex"); while (/^0+$/.test(value));
  return value;
}

function parentContext(parent) {
  if (typeof parent === "string") return parseTraceparent(parent);
  if (!parent || typeof parent !== "object") return undefined;
  let value = parent.context;
  if (typeof value === "function") {
    try { value = value.call(parent); } catch { return undefined; }
  }
  value ??= parent;
  const traceId = String(value.trace_id ?? "").toLowerCase();
  const spanId = String(value.span_id ?? "").toLowerCase();
  const traceFlags = String(value.trace_flags ?? value.flags ?? "01").toLowerCase();
  if (!nonZero(traceId, TRACE_ID) || !nonZero(spanId, SPAN_ID) || !/^[0-9a-f]{2}$/.test(traceFlags)) return undefined;
  return { trace_id: traceId, span_id: spanId, trace_flags: traceFlags };
}

function routeName(method, url = "") {
  const path = String(url).split("?")[0];
  if (path.startsWith("/v1/assets/") && path.endsWith("/content")) {
    return "/v1/assets/:asset_id/content";
  }
  if (path.startsWith("/v1/assets/")) return "/v1/assets/:asset_id";
  if (path.startsWith("/v1/reviews/") && path.endsWith("/decision")) return "/v1/reviews/:review_id/decision";
  if ([
    "/health/live",
    "/health/ready",
    "/metrics",
    "/v1/ask",
    "/v1/events",
    "/v1/tts/synthesize",
  ].includes(path)) return path;
  return `${method}:unmatched`;
}

function normalizeEnum(value, allowed) {
  const normalized = String(value ?? "unknown").toLowerCase();
  return allowed.has(normalized) ? normalized : "unknown";
}

function safeAttributes(attributes = {}) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return Object.freeze({});
  const safe = {};
  for (const [key, allowed] of Object.entries(ENUM_ATTRIBUTES)) {
    if (Object.hasOwn(attributes, key)) safe[key] = normalizeEnum(attributes[key], allowed);
  }
  if (Object.hasOwn(attributes, "http.method")) {
    const method = String(attributes["http.method"] ?? "").toUpperCase();
    safe["http.method"] = HTTP_METHODS.has(method) ? method : "OTHER";
  }
  if (Object.hasOwn(attributes, "http.route")) {
    safe["http.route"] = routeName(safe["http.method"] ?? "OTHER", attributes["http.route"]);
  }
  if (Object.hasOwn(attributes, "http.status_code")) {
    const status = Number(attributes["http.status_code"]);
    safe["http.status_code"] = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
  }
  if (Object.hasOwn(attributes, "error.code")) {
    const code = String(attributes["error.code"] ?? "").toUpperCase();
    safe["error.code"] = ERROR_CODES.has(code) ? code : "UNKNOWN";
  }
  return Object.freeze(safe);
}

function spanName(value) {
  const name = String(value ?? "").toLowerCase();
  return SPAN_NAMES.has(name) ? name : "application.unknown";
}

function errorCode(error) {
  const code = String(error?.code ?? "").toUpperCase();
  return ERROR_CODES.has(code) ? code : "UNKNOWN";
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function createSinkAdapter(sink) {
  if (typeof sink === "function") return { emit: sink };
  if (sink && typeof sink.emit === "function") return sink;
  return undefined;
}

class Span {
  #attributes;
  #ended = false;
  #signal;
  #onAbort;

  constructor({ tracer, name, parent, attributes, signal }) {
    this.tracer = tracer;
    this.name = spanName(name);
    this.startedAt = tracer.now();
    this.#signal = signal;
    const traceId = parent?.trace_id ?? generatedId(tracer.idGenerator, "generateTraceId", 16, TRACE_ID);
    const spanId = generatedId(tracer.idGenerator, "generateSpanId", 8, SPAN_ID);
    this.context = Object.freeze({
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: parent?.span_id,
      trace_flags: parent?.trace_flags ?? "01",
      traceparent: `00-${traceId}-${spanId}-${parent?.trace_flags ?? "01"}`,
    });
    this.#attributes = safeAttributes(attributes);
    this.aborted = Boolean(signal?.aborted);
    this.#onAbort = () => { this.aborted = true; };
    signal?.addEventListener?.("abort", this.#onAbort, { once: true });
  }

  setAttributes(attributes) {
    if (!this.#ended) this.#attributes = safeAttributes({ ...this.#attributes, ...attributes });
    return this;
  }

  end({ status = "ok", error, attributes } = {}) {
    if (this.#ended) return undefined;
    this.#ended = true;
    this.#signal?.removeEventListener?.("abort", this.#onAbort);
    if (attributes) this.#attributes = safeAttributes({ ...this.#attributes, ...attributes });
    const endedAt = this.tracer.now();
    let outcome = SPAN_STATUSES.has(status) ? status : "error";
    if (this.aborted || isAbort(error)) outcome = "aborted";
    else if (error) outcome = "error";
    const finalAttributes = error
      ? safeAttributes({ ...this.#attributes, "error.code": errorCode(error) })
      : this.#attributes;
    const event = Object.freeze({
      type: "span",
      name: this.name,
      trace_id: this.context.trace_id,
      span_id: this.context.span_id,
      ...(this.context.parent_span_id ? { parent_span_id: this.context.parent_span_id } : {}),
      trace_flags: this.context.trace_flags,
      status: outcome,
      started_at: new Date(this.startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      duration_ms: Math.max(0, endedAt - this.startedAt),
      attributes: finalAttributes,
    });
    this.tracer.emit(event);
    return event;
  }
}

/**
 * Transport-neutral tracing port. Its event shape intentionally contains no
 * payload, identity, URL, SQL, token, transcript, or audio fields.
 */
export class Tracer {
  constructor({ sink, now = () => Date.now(), idGenerator } = {}) {
    this.sink = createSinkAdapter(sink);
    this.now = now;
    this.idGenerator = idGenerator;
    this.pending = new Set();
    this.closed = false;
    this.closePromise = undefined;
  }

  startSpan(name, { parent, attributes, signal } = {}) {
    return new Span({ tracer: this, name, parent: parentContext(parent), attributes, signal });
  }

  async runSpan(name, options, operation) {
    if (typeof options === "function") {
      operation = options;
      options = {};
    }
    const span = this.startSpan(name, options);
    try {
      const result = await operation(span);
      span.end({ status: span.aborted ? "aborted" : "ok" });
      return result;
    } catch (error) {
      span.end({ status: span.aborted || isAbort(error) ? "aborted" : "error", error });
      throw error;
    }
  }

  emit(event) {
    if (this.closed || !this.sink) return;
    let emitted;
    try { emitted = this.sink.emit(event); } catch { return; }
    const pending = Promise.resolve(emitted).catch(() => {}).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await Promise.allSettled(this.pending);
      try { await this.sink?.close?.(); } catch {}
    })();
    return this.closePromise;
  }
}

export function createTracer(options) { return new Tracer(options); }

function otelParent(parent) {
  if (parent?.[OTEL_CONTEXT]) return parent[OTEL_CONTEXT];
  const parsed = parentContext(parent);
  if (!parsed) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parsed.trace_id,
    spanId: parsed.span_id,
    traceFlags: Number.parseInt(parsed.trace_flags, 16) & TraceFlags.SAMPLED,
    isRemote: typeof parent === "string",
  });
}

class OtelSpan {
  #span;
  #attributes;
  #ended = false;
  #signal;
  #onAbort;

  constructor({ tracer, name, parent, attributes, signal }) {
    const parentValue = otelParent(parent);
    this.#attributes = safeAttributes(attributes);
    this.#span = tracer.otelTracer.startSpan(
      spanName(name),
      { attributes: this.#attributes },
      parentValue,
    );
    const spanContext = this.#span.spanContext();
    const flags = spanContext.traceFlags.toString(16).padStart(2, "0");
    const parsedParent = parentContext(parent);
    this.context = Object.freeze({
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
      parent_span_id: parsedParent?.span_id,
      trace_flags: flags,
      traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
    });
    this[OTEL_CONTEXT] = trace.setSpan(parentValue, this.#span);
    this.#signal = signal;
    this.aborted = Boolean(signal?.aborted);
    this.#onAbort = () => { this.aborted = true; };
    signal?.addEventListener?.("abort", this.#onAbort, { once: true });
  }

  setAttributes(attributes) {
    if (this.#ended) return this;
    this.#attributes = safeAttributes({ ...this.#attributes, ...attributes });
    this.#span.setAttributes(this.#attributes);
    return this;
  }

  end({ status = "ok", error, attributes } = {}) {
    if (this.#ended) return undefined;
    if (attributes) this.setAttributes(attributes);
    this.#ended = true;
    this.#signal?.removeEventListener?.("abort", this.#onAbort);
    const outcome = this.aborted || isAbort(error)
      ? "aborted"
      : error || status === "error"
        ? "error"
        : "ok";
    if (error) this.#span.setAttribute("error.code", errorCode(error));
    this.#span.setStatus({
      code: outcome === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    });
    this.#span.end();
    return Object.freeze({ ...this.context, status: outcome });
  }
}

/**
 * Explicit OpenTelemetry adapter. It exports only spans created through this
 * bounded port; no HTTP, fetch, provider, SQL, or body auto-instrumentation is
 * installed.
 */
export class OtelTracer {
  constructor({ env = process.env, exporter, spanProcessor } = {}) {
    const serviceName = /^[A-Za-z0-9._-]{1,64}$/.test(env.OTEL_SERVICE_NAME ?? "")
      ? env.OTEL_SERVICE_NAME
      : "sumi-agentic-voice-crm";
    const environment = new Set(["development", "test", "staging", "production"])
      .has(env.APP_ENV)
      ? env.APP_ENV
      : "unknown";
    const traceExporter = exporter ?? new OTLPTraceExporter();
    const processor = spanProcessor ?? new BatchSpanProcessor(traceExporter);
    this.provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        "service.name": serviceName,
        "deployment.environment.name": environment,
      }),
      spanProcessors: [processor],
    });
    this.otelTracer = this.provider.getTracer("sumi-agentic-voice-crm", "0.1.0");
    this.closePromise = undefined;
  }

  startSpan(name, options = {}) {
    return new OtelSpan({ tracer: this, name, ...options });
  }

  async runSpan(name, options, operation) {
    if (typeof options === "function") {
      operation = options;
      options = {};
    }
    const span = this.startSpan(name, options);
    try {
      const value = await operation(span);
      span.end({ status: span.aborted ? "aborted" : "ok" });
      return value;
    } catch (error) {
      span.end({ status: span.aborted || isAbort(error) ? "aborted" : "error", error });
      throw error;
    }
  }

  close() {
    this.closePromise ??= this.provider.shutdown();
    return this.closePromise;
  }
}

export function createOtelTracer(options) { return new OtelTracer(options); }

export function createConfiguredTracer({ env = process.env, ...options } = {}) {
  const mode = env.OBSERVABILITY_MODE ?? "manual";
  if (mode === "manual") return createTracer(options);
  if (mode === "otel") return createOtelTracer({ env, ...options });
  throw new Error("OBSERVABILITY_MODE must be manual or otel");
}

function authorized(header, token) {
  if (!token) return true;
  const actual = Buffer.from(String(header || ""));
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class Observability {
  constructor({ env = process.env, write = (entry) => console.log(JSON.stringify(entry)), tracer = createTracer() } = {}) {
    this.metricsToken = env.METRICS_BEARER_TOKEN;
    this.write = write;
    this.tracer = tracer;
    this.counters = new Map(); this.durations = new Map();
  }

  begin(req, request_id) {
    const method = String(req.method ?? "OTHER").toUpperCase();
    const route = routeName(method, req.url);
    const span = this.tracer.startSpan("http.server", {
      parent: req.headers?.traceparent,
      attributes: { "http.method": method, "http.route": route },
    });
    return {
      ...span.context,
      flags: span.context.trace_flags,
      request_id,
      method,
      route,
      started: process.hrtime.bigint(),
      [ACTIVE_SPAN]: span,
    };
  }

  finish(context, status, error_code) {
    const durationSeconds = Number(process.hrtime.bigint() - context.started) / 1e9;
    const labels = `${context.method}|${context.route}|${status}`;
    this.counters.set(labels, (this.counters.get(labels) ?? 0) + 1);
    this.durations.set(labels, (this.durations.get(labels) ?? 0) + durationSeconds);
    context[ACTIVE_SPAN]?.end({
      status: status === 499 ? "aborted" : status >= 400 ? "error" : "ok",
      attributes: { "http.status_code": status, ...(error_code ? { "error.code": error_code } : {}) },
    });
    this.write({ level: status >= 500 ? "error" : status >= 400 ? "warn" : "info", message: "http_request", request_id: context.request_id, trace_id: context.trace_id, method: context.method, route: context.route, status, duration_ms: Math.round(durationSeconds * 1000), error_code, time: new Date().toISOString() });
  }

  authorizeMetrics(header) { return authorized(header, this.metricsToken); }

  renderMetrics() {
    const lines = ["# HELP sumi_http_requests_total HTTP requests completed.", "# TYPE sumi_http_requests_total counter"];
    for (const [key, count] of [...this.counters].sort()) {
      const [method, route, status] = key.split("|");
      const labels = `method="${method}",route="${route}",status="${status}"`;
      lines.push(`sumi_http_requests_total{${labels}} ${count}`);
    }
    lines.push("# HELP sumi_http_request_duration_seconds HTTP request duration.", "# TYPE sumi_http_request_duration_seconds summary");
    for (const [key, seconds] of [...this.durations].sort()) {
      const [method, route, status] = key.split("|");
      const labels = `method="${method}",route="${route}",status="${status}"`;
      lines.push(`sumi_http_request_duration_seconds_sum{${labels}} ${seconds}`, `sumi_http_request_duration_seconds_count{${labels}} ${this.counters.get(key)}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

export function createObservability(options) { return new Observability(options); }
