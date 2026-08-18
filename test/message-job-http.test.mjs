import assert from "node:assert/strict";
import test from "node:test";
import { CrmStore } from "../src/store.mjs";
import { understanding } from "../src/contracts.mjs";
import { createApp } from "../src/server.mjs";

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
    resolvePrincipal: async (identity) => identity,
    authorize: async () => ({ effect: "allow", obligations: [] }),
    providers: {
      providerReadiness: () => ({ ready: true, statuses: {} }),
      ttsDefaultFormat: () => "mp3",
      understand: async (transcript, { locale }) =>
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
    objectStorage: {
      health: async () => ({ ready: true }),
      close: async () => {},
    },
    observability: {
      begin: () => ({ traceparent: "00-test" }),
      finish: () => {},
      authorizeMetrics: () => true,
      renderMetrics: () => "",
    },
    close: async () => {},
  };
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.listen(0, resolve);
  });
  return app.server.address().port;
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
  const receipt = await response.json();
  assert.match(receipt.job_id, /^job_/);
  assert.ok(["job_queued", "running", "succeeded"].includes(receipt.status));

  const statusResponse = await fetch(
    `http://127.0.0.1:${port}/v1/jobs/${receipt.job_id}`,
    {
      headers: { authorization: "Bearer development-token" },
    },
  );
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.job_id, receipt.job_id);
  assert.ok(["job_queued", "running", "succeeded"].includes(status.status));
  await app.close();
});
