import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createApp, readRequestBody } from "../src/server.mjs";
import { REQUEST_BODY_LIMITS } from "../src/protocol-policy.mjs";

function runtimeFixture(closed) {
  const store = {
    close: async () => closed.push("store"),
    health: async () => ({ ready: true }),
    beginInteraction: async () => ({ replay: false }),
  };
  return {
    store,
    authenticate: async () => ({ tenant_id: "tenant_demo", actor_id: "test-actor" }),
    objectStorage: { health: async () => ({ ready: true }), close: async () => closed.push("objects") },
    observability: { begin: () => ({ traceparent: "00-test" }), finish: () => {}, authorizeMetrics: () => true, renderMetrics: () => "" },
    providers: { providerReadiness: () => ({ ready: true, statuses: {} }) },
    close: async () => { await store.close(); await closed.push("runtime"); },
  };
}

test("createApp is transport-injectable and import does not listen", async () => {
  const closed = [];
  const app = createApp({ runtime: runtimeFixture(closed) });
  assert.equal(app.server.listening, false);
  await new Promise((resolve, reject) => { app.server.once("error", reject); app.listen(0, resolve); });
  const address = app.server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ready");
  await Promise.all([app.close(), app.close()]);
  assert.equal(app.draining, true);
  assert.deepEqual(closed, ["store", "runtime"]);
});

test("client disconnect during authentication aborts before provider or store mutation", async () => {
  const closed = [];
  let releaseAuthentication;
  let beginCalls = 0;
  const runtime = runtimeFixture(closed);
  runtime.authenticate = async () => await new Promise((resolve) => { releaseAuthentication = resolve; });
  runtime.store.beginInteraction = async () => { beginCalls += 1; return { replay: false }; };
  const app = createApp({ runtime });
  await new Promise((resolve, reject) => { app.server.once("error", reject); app.listen(0, resolve); });
  const { port } = app.server.address();
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    path: "/v1/ask",
    method: "POST",
    headers: {
      authorization: "Bearer development-token",
      "content-type": "application/json",
      "idempotency-key": "disconnect-during-auth-0001",
    },
  });
  request.on("error", () => {});
  request.end(JSON.stringify({ input: { type: "text", text: "find Acme" } }));
  while (!releaseAuthentication) await new Promise((resolve) => setImmediate(resolve));
  request.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  releaseAuthentication({ tenant_id: "tenant_demo", actor_id: "test-actor" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(beginCalls, 0);
  await app.close();
});

test("application shutdown bounds HTTP drain and aborts a stuck request", async () => {
  const closed = [];
  let authenticationStarted;
  const started = new Promise((resolve) => { authenticationStarted = resolve; });
  const runtime = runtimeFixture(closed);
  runtime.authenticate = async (_headers, { signal }) => {
    authenticationStarted();
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const app = createApp({ runtime, teardownTimeoutMs: 10 });
  await new Promise((resolve, reject) => { app.server.once("error", reject); app.listen(0, resolve); });
  const request = httpRequest({
    host: "127.0.0.1",
    port: app.server.address().port,
    path: "/v1/ask",
    method: "POST",
    headers: {
      authorization: "Bearer development-token",
      "content-type": "application/json",
      "idempotency-key": "shutdown-during-auth-0001",
    },
  });
  request.on("error", () => {});
  request.end(JSON.stringify({ input: { type: "text", text: "find Acme" } }));
  await started;
  await app.close();
  assert.equal(app.draining, true);
  assert.deepEqual(closed, ["store", "runtime"]);
});

test("request body reader rejects declared and chunked payloads before buffering beyond the cap", async () => {
  await assert.rejects(
    readRequestBody({ headers: { "content-length": String(REQUEST_BODY_LIMITS.ttsJson + 1) } }, REQUEST_BODY_LIMITS.ttsJson),
    (error) => error.code === "PAYLOAD_TOO_LARGE" && error.details.max_bytes === REQUEST_BODY_LIMITS.ttsJson,
  );
  const chunked = {
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(REQUEST_BODY_LIMITS.reviewJson);
      yield Buffer.from("x");
    },
  };
  await assert.rejects(readRequestBody(chunked, REQUEST_BODY_LIMITS.reviewJson), (error) => error.code === "PAYLOAD_TOO_LARGE");
});
