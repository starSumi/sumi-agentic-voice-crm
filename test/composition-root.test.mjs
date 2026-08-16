import assert from "node:assert/strict";
import test from "node:test";
import { createRequestContext, createRuntime } from "../src/composition-root.mjs";

test("composition root creates process resources through injectable ports", async () => {
  const closed = [];
  const runtime = createRuntime({
    env: { APP_ENV: "test", STORE_PROVIDER: "memory", OBJECT_STORAGE_PROVIDER: "memory" },
    overrides: {
      authenticate: async () => ({ tenant_id: "tenant_demo", actor_id: "test-actor" }),
      store: { close: async () => closed.push("store") },
      objectStorage: { close: async () => closed.push("objects") },
      providers: { providerReadiness: () => ({ ready: true }), transcribe: async () => ({}), understand: async () => ({}), synthesize: async () => ({}), ttsDefaultFormat: () => "mp3" },
      observability: { begin: () => ({}), finish: () => {} },
    },
  });
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(runtime.env.APP_ENV, "test");
  await runtime.close();
  assert.deepEqual(closed, ["store", "objects"]);
});

test("request context freezes identity and keeps tenant boundary explicit", () => {
  const context = createRequestContext({ request_id: "req_1234567890abcdef12345678", traceparent: "trace", identity: { tenant_id: "tenant_demo", actor_id: "actor" } });
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.identity), true);
  assert.equal(context.identity.tenant_id, "tenant_demo");
  assert.throws(() => createRequestContext({ request_id: "req_only", identity: { tenant_id: "tenant_demo" } }), /request context requires/);
});
