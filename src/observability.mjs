import { randomBytes, timingSafeEqual } from "node:crypto";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function traceContext(value) {
  const match = TRACEPARENT.exec(String(value || "").toLowerCase());
  if (match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2])) return { trace_id: match[1], parent_span_id: match[2], flags: match[3] };
  return { trace_id: randomBytes(16).toString("hex"), flags: "01" };
}

function routeName(method, url = "") {
  if (url.startsWith("/v1/assets/")) return "/v1/assets/:asset_id";
  if (url.startsWith("/v1/reviews/") && url.endsWith("/decision")) return "/v1/reviews/:review_id/decision";
  return url.split("?")[0] || `${method}:unknown`;
}

function authorized(header, token) {
  if (!token) return true;
  const actual = Buffer.from(String(header || ""));
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class Observability {
  constructor({ env = process.env, write = (entry) => console.log(JSON.stringify(entry)) } = {}) {
    this.metricsToken = env.METRICS_BEARER_TOKEN;
    this.write = write;
    this.counters = new Map(); this.durations = new Map();
  }

  begin(req, request_id) {
    const trace = traceContext(req.headers.traceparent);
    const span_id = randomBytes(8).toString("hex");
    return { ...trace, span_id, request_id, method: req.method, route: routeName(req.method, req.url), started: process.hrtime.bigint(), traceparent: `00-${trace.trace_id}-${span_id}-${trace.flags}` };
  }

  finish(context, status, error_code) {
    const durationSeconds = Number(process.hrtime.bigint() - context.started) / 1e9;
    const labels = `${context.method}|${context.route}|${status}`;
    this.counters.set(labels, (this.counters.get(labels) ?? 0) + 1);
    this.durations.set(labels, (this.durations.get(labels) ?? 0) + durationSeconds);
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
