import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { testError, testErrorDetails, testRecord } from "./test-types.ts";
import { createApp, readRequestBody } from "../src/server.ts";
import { createRuntime } from "../src/composition-root.ts";
import { REQUEST_BODY_LIMITS } from "../src/protocol-policy.ts";
import { CrmStore } from "../src/store.ts";
import { MemoryObjectStorage } from "../src/object-storage.ts";
import { createObservability } from "../src/observability.ts";

type TestIdentity = { readonly actor_id: string; readonly tenant_id: string };

function tcpPort(address: AddressInfo | string | null): number {
  if (!address || typeof address === "string") {
    throw new TypeError("expected TCP server address");
  }
  return address.port;
}

function runtimeFixture(closed: string[]) {
  const store = Object.assign(new CrmStore(), {
    close: async () => {
      closed.push("store");
    },
  });
  return {
    store,
    authenticate: async (
      _headers?: Headers,
      _options?: { readonly signal?: AbortSignal },
    ): Promise<TestIdentity> => ({
      tenant_id: "tenant_demo",
      actor_id: "test-actor",
    }),
    objectStorage: new MemoryObjectStorage(),
    observability: createObservability({ write: () => {} }),
    providers: {
      providerReadiness: () => ({
        ready: true,
        names: { asr: "test", intent: "test", tts: "test" },
        statuses: {
          asr: { provider: "test", ready: true, circuit: "closed" },
          intent: { provider: "test", ready: true, circuit: "closed" },
          tts: { provider: "test", ready: true, circuit: "closed" },
        },
      }),
      transcribe: async () => ({
        text: "test",
        language: "en",
        confidence: 1,
        provider: "test",
        model: "test",
        duration_ms: 0,
      }),
      understand: async () => ({
        intent: "crm.search",
        confidence: 1,
        entities: {},
        missing: [],
        needs_confirmation: false,
        schema_version: "sumi.agent-crm-understanding.v1",
        source: {
          transcript_hash: `sha256:${"0".repeat(64)}`,
          language: "en",
          model: "test",
        },
      }),
      synthesize: async () => ({
        asset_id: "ast_test",
        url: "/v1/assets/ast_test",
        mime_type: "audio/mpeg",
        duration_ms: 0,
        expires_at: "2030-01-01T00:00:00.000Z",
        voice: "test",
        provider: "test",
        model: "test",
        status: "ready",
        data_base64: "",
      }),
      ttsDefaultFormat: () => "mp3",
    },
    close: async () => {
      await store.close();
      closed.push("runtime");
    },
  };
}

test("createApp is transport-injectable and import does not listen", async () => {
  const closed: string[] = [];
  const app = createApp({ runtime: runtimeFixture(closed) });
  assert.equal(app.server.listening, false);
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.listen(0, resolve);
  });
  const response = await fetch(
    `http://127.0.0.1:${tcpPort(app.server.address())}/health/ready`,
  );
  assert.equal(response.status, 200);
  assert.equal(testRecord(await response.json()).status, "ready");
  await Promise.all([app.close(), app.close()]);
  assert.equal(app.draining, true);
  assert.deepEqual(closed, ["store", "runtime"]);
});

test("application ingress rate limiting returns a bounded retry hint", async () => {
  const closed: string[] = [];
  const runtime = {
    ...runtimeFixture(closed),
    env: {
      RATE_LIMIT_WINDOW_MS: "60000",
      RATE_LIMIT_MAX_REQUESTS: "1",
      RATE_LIMIT_MAX_KEYS: "10",
    },
  };
  const app = createApp({ runtime });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.listen(0, resolve);
  });
  try {
    const origin = `http://127.0.0.1:${tcpPort(app.server.address())}`;
    assert.equal((await fetch(`${origin}/v1/not-found`)).status, 404);
    const limited = await fetch(`${origin}/v1/not-found`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(
      testRecord(testRecord(await limited.json()).error).code,
      "RATE_LIMITED",
    );
    assert.equal((await fetch(`${origin}/health/live`)).status, 200);
  } finally {
    await app.close();
  }
});

test("client disconnect during authentication aborts before provider or store mutation", async () => {
  const closed: string[] = [];
  let releaseAuthentication: ((identity: TestIdentity) => void) | undefined;
  let beginCalls = 0;
  const runtime = runtimeFixture(closed);
  runtime.authenticate = async () =>
    await new Promise<TestIdentity>((resolve) => {
      releaseAuthentication = resolve;
    });
  runtime.store.beginInteraction = () => {
    beginCalls += 1;
    return { replay: false };
  };
  const app = createApp({ runtime });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.listen(0, resolve);
  });
  const port = tcpPort(app.server.address());
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
  while (!releaseAuthentication)
    await new Promise<void>((resolve) => setImmediate(resolve));
  request.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (!releaseAuthentication) throw new Error("authentication did not start");
  releaseAuthentication({ tenant_id: "tenant_demo", actor_id: "test-actor" });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(beginCalls, 0);
  await app.close();
});

test("application shutdown bounds HTTP drain and aborts a stuck request", async () => {
  const closed: string[] = [];
  let authenticationStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    authenticationStarted = resolve;
  });
  const runtime = runtimeFixture(closed);
  runtime.authenticate = async (_headers, options) => {
    authenticationStarted?.();
    const signal = options?.signal;
    if (!signal) throw new TypeError("expected request abort signal");
    return await new Promise<TestIdentity>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  };
  const app = createApp({ runtime, teardownTimeoutMs: 10 });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.listen(0, resolve);
  });
  const request = httpRequest({
    host: "127.0.0.1",
    port: tcpPort(app.server.address()),
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

test("PostgreSQL review adapter preserves token-bound authorization facts", async () => {
  let decisionInput: Readonly<Record<string, unknown>> | undefined;
  class ReviewBoundaryStore extends CrmStore {
    async principalFor(identity: Readonly<Record<string, unknown>>) {
      return {
        ...identity,
        subject_id: identity.actor_id,
        kind: "human",
        status: "active",
        roles: ["tenant_admin"],
        actor_scopes: ["review.decide"],
        policy_version: "test-policy.v1",
      };
    }

    async decideReview(input: Readonly<Record<string, unknown>>) {
      decisionInput = input;
      return {
        review_id: input.review_id,
        status: "rejected",
        decision: { decision: input.decision },
      };
    }
  }

  const store = new ReviewBoundaryStore();
  const app = createApp({
    runtimeFactory: () =>
      createRuntime({
        env: {
          APP_ENV: "test",
          STORE_PROVIDER: "memory",
          OBJECT_STORAGE_PROVIDER: "memory",
        },
        overrides: {
          store,
          authenticate: async () => ({
            tenant_id: "tenant_demo",
            actor_id: "reviewer-actor",
            principal_kind: "human",
            token_scopes: ["review.decide"],
            authentication_methods: ["static_token"],
            network_zone: "private",
          }),
          authorize: async () => ({
            effect: "allow",
            policy_version: "test-policy.v1",
            reason_codes: ["ALLOW"],
            obligations: [],
          }),
        },
      }),
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.listen(0, resolve);
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${tcpPort(app.server.address())}/v1/reviews/rev_abcd/decision`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "idempotency-key": "review-boundary-0001",
        },
        body: JSON.stringify({ decision: "reject" }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(decisionInput?.token_scopes, ["review.decide"]);
    assert.deepEqual(decisionInput?.authentication_methods, ["static_token"]);
    assert.equal(decisionInput?.network_zone, "private");
  } finally {
    await app.close();
  }
});

test("request body reader rejects declared and chunked payloads before buffering beyond the cap", async () => {
  await assert.rejects(
    readRequestBody(
      {
        headers: { "content-length": String(REQUEST_BODY_LIMITS.ttsJson + 1) },
      },
      REQUEST_BODY_LIMITS.ttsJson,
    ),
    (error) =>
      testError(error).code === "PAYLOAD_TOO_LARGE" &&
      testErrorDetails(error).max_bytes === REQUEST_BODY_LIMITS.ttsJson,
  );
  const chunked = {
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(REQUEST_BODY_LIMITS.reviewJson);
      yield Buffer.from("x");
    },
  };
  await assert.rejects(
    readRequestBody(chunked, REQUEST_BODY_LIMITS.reviewJson),
    (error) => testError(error).code === "PAYLOAD_TOO_LARGE",
  );
});
