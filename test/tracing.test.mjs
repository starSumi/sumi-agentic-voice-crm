import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createRuntime } from "../src/composition-root.mjs";
import {
  createConfiguredTracer,
  createOtelTracer,
  createTracer,
  parseTraceparent,
} from "../src/observability.mjs";

const VALID_PARENT = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

function ids() {
  const spanIds = ["1111111111111111", "2222222222222222", "3333333333333333"];
  return {
    generateTraceId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    generateSpanId: () => spanIds.shift(),
  };
}

test("traceparent parser accepts version 00 and rejects invalid or all-zero identifiers", () => {
  assert.deepEqual(parseTraceparent(VALID_PARENT), {
    trace_id: "0123456789abcdef0123456789abcdef",
    span_id: "0123456789abcdef",
    trace_flags: "01",
  });
  assert.equal(parseTraceparent("not-a-traceparent"), undefined);
  assert.equal(parseTraceparent("00-00000000000000000000000000000000-0123456789abcdef-01"), undefined);
  assert.equal(parseTraceparent("00-0123456789abcdef0123456789abcdef-0000000000000000-01"), undefined);

  const tracer = createTracer({ idGenerator: ids() });
  const invalidParent = tracer.startSpan("application.ask", { parent: "not-a-traceparent" });
  const zeroParent = tracer.startSpan("application.ask", {
    parent: "00-00000000000000000000000000000000-0000000000000000-01",
  });
  assert.equal(invalidParent.context.trace_id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(invalidParent.context.parent_span_id, undefined);
  assert.equal(zeroParent.context.trace_id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(zeroParent.context.parent_span_id, undefined);
});

test("tracer preserves parentage and emits JSON-safe bounded events", async () => {
  const events = [];
  let now = 1_700_000_000_000;
  const tracer = createTracer({ sink: (event) => events.push(event), idGenerator: ids(), now: () => now++ });
  const root = tracer.startSpan("application.ask", {
    parent: VALID_PARENT,
    attributes: {
      "app.operation": "ask",
      "input.type": "audio",
      transcript: "secret transcript",
      token: "secret token",
      signed_url: "https://secret.invalid/signed?token=secret",
      sql: "select secret from customer",
      audio: Buffer.from("secret audio"),
    },
  });
  const child = tracer.startSpan("provider.asr", {
    parent: root,
    attributes: { "provider.kind": "dashscope" },
  });
  child.end();
  root.end();
  await tracer.close();

  assert.equal(child.context.trace_id, root.context.trace_id);
  assert.equal(child.context.parent_span_id, root.context.span_id);
  assert.equal(root.context.parent_span_id, "0123456789abcdef");
  assert.equal(events[0].name, "provider.asr");
  assert.equal(events[0].parent_span_id, root.context.span_id);
  assert.deepEqual(events[1].attributes, { "app.operation": "ask", "input.type": "audio" });
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /secret|signed|select|transcript|token/i);
  assert.equal(Object.hasOwn(events[1].attributes, "audio"), false);
});

test("runSpan records errors and aborts without exposing error messages", async () => {
  const events = [];
  const tracer = createTracer({ sink: (event) => events.push(event), idGenerator: ids() });
  const failure = Object.assign(new Error("provider leaked a secret token"), { code: "UPSTREAM_UNAVAILABLE" });
  await assert.rejects(tracer.runSpan("provider.tts", {}, async () => { throw failure; }), failure);

  const controller = new AbortController();
  const result = await tracer.runSpan("application.tts", { signal: controller.signal }, async () => {
    controller.abort("private reason");
    return "business-result";
  });
  assert.equal(result, "business-result");
  await tracer.close();

  assert.equal(events[0].status, "error");
  assert.equal(events[0].attributes["error.code"], "UPSTREAM_UNAVAILABLE");
  assert.equal(events[1].status, "aborted");
  assert.doesNotMatch(JSON.stringify(events), /leaked|secret token|private reason/);
});

test("unknown names and attribute values collapse to low-cardinality fallbacks", async () => {
  const events = [];
  const tracer = createTracer({ sink: (event) => events.push(event), idGenerator: ids() });
  tracer.startSpan("customer.123456", {
    attributes: {
      "app.operation": "customer-123456",
      "http.method": "CUSTOM-123456",
      "http.route": "/customers/123456",
      "error.code": "CUSTOMER_123456",
    },
  }).end();
  await tracer.close();
  assert.equal(events[0].name, "application.unknown");
  assert.deepEqual(events[0].attributes, {
    "app.operation": "unknown",
    "http.method": "OTHER",
    "http.route": "OTHER:unmatched",
    "error.code": "UNKNOWN",
  });
  assert.doesNotMatch(JSON.stringify(events[0]), /123456|customers/);
});

test("sink failure is observational and runtime closes every resource once", async () => {
  let sinkCloses = 0;
  const closed = [];
  const tracer = createTracer({
    sink: {
      emit: async () => { throw new Error("export unavailable"); },
      close: async () => { sinkCloses += 1; },
    },
    idGenerator: ids(),
  });
  assert.equal(await tracer.runSpan("application.review", async () => "ok"), "ok");
  const runtime = createRuntime({
    env: { APP_ENV: "test", STORE_PROVIDER: "memory", OBJECT_STORAGE_PROVIDER: "memory" },
    overrides: {
      tracer,
      authenticate: async () => ({ tenant_id: "tenant_demo", actor_id: "test-actor" }),
      store: { close: async () => closed.push("store") },
      objectStorage: { close: async () => closed.push("objects") },
      providers: {},
      observability: {},
    },
  });
  await runtime.close();
  await runtime.close();
  assert.deepEqual(closed, ["store", "objects"]);
  assert.equal(sinkCloses, 1);
});

test("configured OpenTelemetry mode exports only explicit redacted spans", async () => {
  const exporter = new InMemorySpanExporter();
  const tracer = createOtelTracer({
    env: { APP_ENV: "test", OTEL_SERVICE_NAME: "sumi-test" },
    spanProcessor: new SimpleSpanProcessor(exporter),
  });
  await tracer.runSpan("application.ask", {
    parent: VALID_PARENT,
    attributes: {
      "app.operation": "ask",
      "input.type": "text",
      transcript: "must never be exported",
      token: "must never be exported",
    },
  }, async (span) => tracer.runSpan("provider.intent", {
    parent: span,
    attributes: { "provider.kind": "mock", signed_url: "https://secret.invalid" },
  }, async () => "ok"));

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 2);
  const application = spans.find((span) => span.name === "application.ask");
  const provider = spans.find((span) => span.name === "provider.intent");
  assert.equal(provider.parentSpanContext.spanId, application.spanContext().spanId);
  assert.deepEqual(application.attributes, {
    "app.operation": "ask",
    "input.type": "text",
  });
  assert.deepEqual(provider.attributes, { "provider.kind": "mock" });
  assert.doesNotMatch(JSON.stringify(spans.map((span) => span.attributes)), /secret|transcript|token|signed/i);
  await tracer.close();
});

test("configured tracer defaults to manual mode and rejects unknown modes", () => {
  assert.equal(createConfiguredTracer({ env: {} }).constructor.name, "Tracer");
  assert.throws(
    () => createConfiguredTracer({ env: { OBSERVABILITY_MODE: "automatic" } }),
    /manual or otel/,
  );
});
