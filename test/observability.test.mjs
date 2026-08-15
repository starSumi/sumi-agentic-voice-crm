import assert from "node:assert/strict";
import test from "node:test";
import { Observability } from "../src/observability.mjs";

test("observability propagates trace context and emits bounded-cardinality metrics", () => {
  const logs = [];
  const telemetry = new Observability({ env: { METRICS_BEARER_TOKEN: "secret" }, write: (entry) => logs.push(entry) });
  const context = telemetry.begin({ method: "GET", url: "/v1/assets/ast_private", headers: { traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" } }, "req-1");
  assert.equal(context.trace_id, "0123456789abcdef0123456789abcdef");
  assert.match(context.traceparent, /^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/);
  telemetry.finish(context, 200);
  const metrics = telemetry.renderMetrics();
  assert.match(metrics, /route="\/v1\/assets\/:asset_id"/);
  assert.doesNotMatch(metrics, /ast_private/);
  assert.equal(logs[0].trace_id, context.trace_id);
  assert.equal(telemetry.authorizeMetrics("Bearer secret"), true);
  assert.equal(telemetry.authorizeMetrics("Bearer wrong"), false);
});
