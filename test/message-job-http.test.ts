import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { testRecord } from "./test-types.ts";
import { CrmStore } from "../src/store.ts";
import { understanding } from "../src/contracts.ts";
import { createApp } from "../src/server.ts";
import { MemoryObjectStorage } from "../src/object-storage.ts";
import { createObservability } from "../src/observability.ts";
import type { AuthorizationDecision } from "../src/authorization/index.ts";

function runtimeFixture() {
  const store = new CrmStore();
  return {
    env: { MESSAGE_JOB_POLL_INTERVAL_MS: "5" },
    store,
    authenticate: async () => ({
      tenant_id: "tenant_demo",
      actor_id: "actor-a",
      subject_id: "actor-a",
      kind: "human",
      status: "active",
      roles: ["agent"],
      actor_scopes: ["interaction.ask"],
      token_scopes: ["interaction.ask"],
    }),
    resolvePrincipal: async (identity: unknown) => identity,
    authorize: async (): Promise<AuthorizationDecision> => ({
      effect: "allow",
      policy_version: "test-policy",
      reason_codes: ["ALLOW"],
      obligations: [],
    }),
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
      ttsDefaultFormat: () => "mp3",
      understand: async (
        transcript: string,
        { locale }: { readonly locale: string },
      ) =>
        understanding({
          intent: "crm.search",
          confidence: 0.99,
          entities: {},
          missing: [],
          needs_confirmation: false,
          transcript,
          language: locale.slice(0, 2),
          model: "test-intent-1",
        }),
      transcribe: async () => ({
        text: "",
        language: "en",
        confidence: 1,
        provider: "test",
        model: "test-asr-1",
        duration_ms: 1,
      }),
      synthesize: async () => {
        throw new Error("tts should not run");
      },
    },
    objectStorage: new MemoryObjectStorage(),
    observability: createObservability({ write: () => {} }),
    close: async () => {},
  };
}

async function listen(app: ReturnType<typeof createApp>) {
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.listen(0, resolve);
  });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new TypeError("expected TCP server address");
  }
  return (address satisfies AddressInfo).port;
}

test("respond-async persists a job receipt and exposes durable status", async () => {
  const runtime = runtimeFixture();
  const app = createApp({ runtime });
  const port = await listen(app);
  const response = await fetch(`http://127.0.0.1:${port}/v1/ask`, {
    method: "POST",
    headers: {
      authorization: "Bearer development-token",
      "content-type": "application/json",
      prefer: "respond-async",
      "idempotency-key": "async-job-key-001",
    },
    body: JSON.stringify({
      input: { type: "text", text: "find acme" },
      output_mode: "text",
    }),
  });
  assert.equal(response.status, 202);
  const receipt = testRecord(await response.json());
  const jobId = receipt.job_id;
  const receiptStatus = receipt.status;
  assert.equal(typeof jobId, "string");
  assert.equal(typeof receiptStatus, "string");
  if (typeof jobId !== "string" || typeof receiptStatus !== "string") {
    throw new TypeError("invalid message job receipt");
  }
  assert.match(jobId, /^job_/);
  assert.ok(["job_queued", "running", "succeeded"].includes(receiptStatus));

  const statusResponse = await fetch(
    `http://127.0.0.1:${port}/v1/jobs/${jobId}`,
    {
      headers: { authorization: "Bearer development-token" },
    },
  );
  assert.equal(statusResponse.status, 200);
  const status = testRecord(await statusResponse.json());
  assert.equal(status.job_id, jobId);
  assert.equal(typeof status.status, "string");
  assert.ok(
    typeof status.status === "string" &&
      ["job_queued", "running", "succeeded"].includes(status.status),
  );
  const statsResponse = await fetch(`http://127.0.0.1:${port}/v1/jobs/stats`, {
    headers: { authorization: "Bearer development-token" },
  });
  assert.equal(statsResponse.status, 200);
  const stats = testRecord(await statsResponse.json());
  assert.equal(typeof testRecord(stats.jobs).job_queued, "number");
  await app.close();
});
