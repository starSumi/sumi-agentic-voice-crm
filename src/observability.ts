import { randomBytes, timingSafeEqual } from "node:crypto";
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Context, Span as OtelApiSpan, Tracer as OtelApiTracer } from "@opentelemetry/api";
import type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ERROR_CODES as PROTOCOL_ERROR_CODES } from "./protocol-policy.ts";

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

export type TraceContext = Readonly<{
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  trace_flags: string;
  traceparent?: string;
}>;
export type TraceAttributes = Readonly<Record<string, unknown>>;
export type BoundedAttributes = Readonly<Record<string, string | number>>;
export type SpanOutcome = "ok" | "error" | "aborted";
export type SpanEvent = Readonly<{
  type: "span";
  name: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  trace_flags: string;
  status: SpanOutcome;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  attributes: BoundedAttributes;
}>;
export type TraceParent = string | TraceContext | { readonly context?: unknown } | undefined;
export type SpanOptions = { parent?: TraceParent; attributes?: TraceAttributes; signal?: AbortSignal };
export type SpanEndOptions = { status?: SpanOutcome; error?: unknown; attributes?: TraceAttributes };
export type SpanLike = { readonly context: TraceContext; readonly aborted: boolean; setAttributes(attributes: TraceAttributes): SpanLike; end(options?: SpanEndOptions): SpanEvent | Readonly<Record<string, unknown>> | undefined };
export type TraceSink = { emit(event: SpanEvent): void | PromiseLike<void>; close?: () => void | PromiseLike<void> } | ((event: SpanEvent) => void | PromiseLike<void>);
export type IdGenerator = { generateTraceId?: () => string; generateSpanId?: () => string };

async function runSpanLifecycle<T>(
  start: (options: SpanOptions) => SpanLike,
  options: SpanOptions | ((span: SpanLike) => T | PromiseLike<T>),
  operation?: (span: SpanLike) => T | PromiseLike<T>,
): Promise<T> {
  const actualOptions = typeof options === "function" ? {} : options;
  const actualOperation = typeof options === "function" ? options : operation;
  if (!actualOperation) throw new TypeError("trace operation is required");
  const span = start(actualOptions);
  try {
    const result = await actualOperation(span);
    span.end({ status: span.aborted ? "aborted" : "ok" });
    return result;
  } catch (error) {
    span.end({ status: span.aborted || isAbort(error) ? "aborted" : "error", error });
    throw error;
  }
}

function nonZero(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && !/^0+$/.test(value);
}

/** Parse only the W3C version-00 form supported by this service. */
export function parseTraceparent(value: unknown): TraceContext | undefined {
  if (typeof value !== "string") return undefined;
  const match = TRACEPARENT.exec(value.toLowerCase());
  if (!match || !nonZero(match[1], TRACE_ID) || !nonZero(match[2], SPAN_ID)) return undefined;
  return Object.freeze({ trace_id: match[1], span_id: match[2], trace_flags: match[3] });
}

function generatedId(generator: IdGenerator | undefined, key: "generateTraceId" | "generateSpanId", bytes: number, pattern: RegExp): string {
  try {
    const value = String(generator?.[key]?.() ?? "").toLowerCase();
    if (nonZero(value, pattern)) return value;
  } catch {}
  let value;
  do value = randomBytes(bytes).toString("hex"); while (/^0+$/.test(value));
  return value;
}

function parentContext(parent: TraceParent): TraceContext | undefined {
  if (typeof parent === "string") return parseTraceparent(parent);
  if (!parent || typeof parent !== "object") return undefined;
  let value: unknown = "context" in parent ? parent.context : parent;
  if (typeof value === "function") {
    try { value = value.call(parent); } catch { return undefined; }
  }
  value ??= parent;
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const traceId = String(record.trace_id ?? "").toLowerCase();
  const spanId = String(record.span_id ?? "").toLowerCase();
  const traceFlags = String(record.trace_flags ?? record.flags ?? "01").toLowerCase();
  if (!nonZero(traceId, TRACE_ID) || !nonZero(spanId, SPAN_ID) || !/^[0-9a-f]{2}$/.test(traceFlags)) return undefined;
  return { trace_id: traceId, span_id: spanId, trace_flags: traceFlags };
}

function routeName(method: string, url = ""): string {
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

function normalizeEnum(value: unknown, allowed: ReadonlySet<string>): string {
  const normalized = String(value ?? "unknown").toLowerCase();
  return allowed.has(normalized) ? normalized : "unknown";
}

function safeAttributes(attributes: TraceAttributes = {}): BoundedAttributes {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return Object.freeze({});
  const safe: Record<string, string | number> = {};
  for (const [key, allowed] of Object.entries(ENUM_ATTRIBUTES)) {
    if (Object.hasOwn(attributes, key)) safe[key] = normalizeEnum(attributes[key], allowed);
  }
  if (Object.hasOwn(attributes, "http.method")) {
    const method = String(attributes["http.method"] ?? "").toUpperCase();
    safe["http.method"] = HTTP_METHODS.has(method) ? method : "OTHER";
  }
  if (Object.hasOwn(attributes, "http.route")) {
    safe["http.route"] = routeName(String(safe["http.method"] ?? "OTHER"), String(attributes["http.route"] ?? ""));
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

function spanName(value: unknown): string {
  const name = String(value ?? "").toLowerCase();
  return SPAN_NAMES.has(name) ? name : "application.unknown";
}

function errorCode(error: unknown): string {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = String(candidate.code ?? "").toUpperCase();
  return ERROR_CODES.has(code) ? code : "UNKNOWN";
}

function isAbort(error: unknown): boolean {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

function createSinkAdapter(sink: TraceSink | undefined): { emit: (event: SpanEvent) => void | PromiseLike<void>; close?: () => void | PromiseLike<void> } | undefined {
  if (typeof sink === "function") return { emit: sink };
  if (sink && typeof sink.emit === "function") return sink;
  return undefined;
}

class Span {
  #attributes: BoundedAttributes;
  #ended = false;
  #signal?: AbortSignal;
  #onAbort: () => void;
  readonly tracer: Tracer;
  readonly name: string;
  readonly startedAt: number;
  readonly context: TraceContext;
  aborted: boolean;

  constructor({ tracer, name, parent, attributes, signal }: { tracer: Tracer; name: string; parent?: TraceContext; attributes?: TraceAttributes; signal?: AbortSignal }) {
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

  setAttributes(attributes: TraceAttributes): this {
    if (!this.#ended) this.#attributes = safeAttributes({ ...this.#attributes, ...attributes });
    return this;
  }

  end({ status = "ok", error, attributes }: SpanEndOptions = {}): SpanEvent | undefined {
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
  readonly sink?: ReturnType<typeof createSinkAdapter>;
  readonly now: () => number;
  readonly idGenerator?: IdGenerator;
  readonly pending = new Set<Promise<void>>();
  closed = false;
  closePromise?: Promise<void>;

  constructor({ sink, now = () => Date.now(), idGenerator }: { sink?: TraceSink; now?: () => number; idGenerator?: IdGenerator } = {}) {
    this.sink = createSinkAdapter(sink);
    this.now = now;
    this.idGenerator = idGenerator;
    this.pending = new Set();
    this.closed = false;
    this.closePromise = undefined;
  }

  startSpan(name: string, { parent, attributes, signal }: SpanOptions = {}): Span {
    return new Span({ tracer: this, name, parent: parentContext(parent), attributes, signal });
  }

  async runSpan<T>(name: string, options: SpanOptions | ((span: SpanLike) => T | PromiseLike<T>), operation?: (span: SpanLike) => T | PromiseLike<T>): Promise<T> {
    return runSpanLifecycle((spanOptions) => this.startSpan(name, spanOptions), options, operation);
  }

  emit(event: SpanEvent): void {
    if (this.closed || !this.sink) return;
    let emitted;
    try { emitted = this.sink.emit(event); } catch { return; }
    const pending = Promise.resolve(emitted).catch(() => {}).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await Promise.allSettled(this.pending);
      try { await this.sink?.close?.(); } catch {}
    })();
    return this.closePromise;
  }
}

export function createTracer(options?: ConstructorParameters<typeof Tracer>[0]): Tracer { return new Tracer(options); }

function otelParent(parent: TraceParent): Context {
  if (parent && typeof parent === "object") {
    const candidate = parent as { readonly [OTEL_CONTEXT]?: Context };
    if (candidate[OTEL_CONTEXT]) return candidate[OTEL_CONTEXT];
  }
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
  #span: OtelApiSpan;
  #attributes: BoundedAttributes;
  #ended = false;
  #signal?: AbortSignal;
  #onAbort: () => void;
  readonly context: TraceContext;
  readonly [OTEL_CONTEXT]: Context;
  aborted: boolean;

  constructor({ tracer, name, parent, attributes, signal }: { tracer: OtelTracer; name: string; parent?: TraceParent; attributes?: TraceAttributes; signal?: AbortSignal }) {
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

  setAttributes(attributes: TraceAttributes): this {
    if (this.#ended) return this;
    this.#attributes = safeAttributes({ ...this.#attributes, ...attributes });
    this.#span.setAttributes(this.#attributes);
    return this;
  }

  end({ status = "ok", error, attributes }: SpanEndOptions = {}): Readonly<Record<string, unknown>> | undefined {
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
  readonly provider: NodeTracerProvider;
  readonly otelTracer: OtelApiTracer;
  closePromise?: Promise<void>;

  constructor({ env = process.env, exporter, spanProcessor }: { env?: NodeJS.ProcessEnv; exporter?: SpanExporter; spanProcessor?: SpanProcessor } = {}) {
    const serviceName = /^[A-Za-z0-9._-]{1,64}$/.test(env.OTEL_SERVICE_NAME ?? "")
      ? env.OTEL_SERVICE_NAME
      : "sumi-agentic-voice-crm";
    const environment = new Set(["development", "test", "staging", "production"])
      .has(env.APP_ENV ?? "")
      ? env.APP_ENV ?? ""
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

  startSpan(name: string, options: SpanOptions = {}): OtelSpan {
    return new OtelSpan({ tracer: this, name, ...options });
  }

  async runSpan<T>(name: string, options: SpanOptions | ((span: SpanLike) => T | PromiseLike<T>), operation?: (span: SpanLike) => T | PromiseLike<T>): Promise<T> {
    return runSpanLifecycle((spanOptions) => this.startSpan(name, spanOptions), options, operation);
  }

  close() {
    this.closePromise ??= this.provider.shutdown();
    return this.closePromise;
  }
}

export function createOtelTracer(options?: ConstructorParameters<typeof OtelTracer>[0]): OtelTracer { return new OtelTracer(options); }

export function createConfiguredTracer({ env = process.env, ...options }: { env?: NodeJS.ProcessEnv; sink?: TraceSink; now?: () => number; idGenerator?: IdGenerator; exporter?: SpanExporter; spanProcessor?: SpanProcessor } = {}): Tracer | OtelTracer {
  const mode = env.OBSERVABILITY_MODE ?? "manual";
  if (mode === "manual") return createTracer(options);
  if (mode === "otel") return createOtelTracer({ env, ...options });
  throw new Error("OBSERVABILITY_MODE must be manual or otel");
}

function authorized(header: unknown, token: string | undefined): boolean {
  if (!token) return true;
  const actual = Buffer.from(String(header || ""));
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type HttpRequestLike = { method?: unknown; url?: unknown; headers?: Record<string, unknown> };
export type ObservabilityContext = TraceContext & {
  readonly flags: string;
  readonly request_id: string;
  readonly method: string;
  readonly route: string;
  readonly started: bigint;
  readonly [ACTIVE_SPAN]: SpanLike;
};

export class Observability {
  readonly metricsToken?: string;
  readonly write: (entry: Record<string, unknown>) => void;
  readonly tracer: Tracer | OtelTracer;
  readonly counters = new Map<string, number>();
  readonly durations = new Map<string, number>();

  constructor({ env = process.env, write = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry)), tracer = createTracer() }: { env?: NodeJS.ProcessEnv; write?: (entry: Record<string, unknown>) => void; tracer?: Tracer | OtelTracer } = {}) {
    this.metricsToken = env.METRICS_BEARER_TOKEN;
    this.write = write;
    this.tracer = tracer;
    this.counters = new Map(); this.durations = new Map();
  }

  begin(req: HttpRequestLike, request_id: string): ObservabilityContext {
    const method = String(req.method ?? "OTHER").toUpperCase();
    const route = routeName(method, String(req.url ?? ""));
    const span = this.tracer.startSpan("http.server", {
      parent: typeof req.headers?.traceparent === "string" ? req.headers.traceparent : undefined,
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

  finish(context: ObservabilityContext, status: number, error_code?: string): void {
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

  authorizeMetrics(header: unknown): boolean { return authorized(header, this.metricsToken); }

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

export function createObservability(options?: ConstructorParameters<typeof Observability>[0]): Observability { return new Observability(options); }
