import assert from "node:assert/strict";
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
