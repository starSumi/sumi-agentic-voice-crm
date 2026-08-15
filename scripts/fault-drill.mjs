import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { OutboxRelay, outboxConfig } from "../src/outbox-relay.mjs";
import { isolatedDrillEnv } from "./drill-env.mjs";

async function listen(server) {
  return await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
}

const provider = createServer(() => {});
const providerPort = await listen(provider);
const portProbe = createServer();
const appPort = await listen(portProbe); await new Promise((resolve) => portProbe.close(resolve));
const app = spawn(process.execPath, ["src/server.mjs"], {
  env: isolatedDrillEnv({
    PORT: String(appPort),
    APP_ENV: "test",
    AUTH_MODE: "development",
    STORE_PROVIDER: "memory",
    OBJECT_STORAGE_PROVIDER: "memory",
    ASR_PROVIDER: "mock",
    INTENT_PROVIDER: "openai-compatible",
    TTS_PROVIDER: "mock",
    OPENAI_API_KEY: "fault-drill",
    OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
    OPENAI_MODEL: "fault-intent",
    PROVIDER_TIMEOUT_MS: "60",
  }),
  stdio: ["ignore", "pipe", "pipe"],
});
let diagnostics = ""; app.stderr.on("data", (data) => { diagnostics += data; });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`fault target startup timed out: ${diagnostics}`)), 10_000);
  app.stdout.on("data", (data) => { if (String(data).includes(`:${appPort}`)) { clearTimeout(timer); resolve(); } });
  app.once("exit", (code) => reject(new Error(`fault target exited with ${code}: ${diagnostics}`)));
});

const failures = [];
try {
  for (let index = 0; index < 4; index += 1) {
    const response = await fetch(`http://127.0.0.1:${appPort}/v1/ask`, { method: "POST", headers: { authorization: "Bearer fault-actor", "x-tenant-id": "tenant_demo", "idempotency-key": `fault-intent-${index}`, "content-type": "application/json" }, body: JSON.stringify({ input: { type: "text", text: "find customer" }, output_mode: "text", locale: "en-US" }) });
    const body = await response.json(); failures.push({ status: response.status, code: body.error?.code, message: body.error?.message });
  }
  assert.ok(failures.slice(0, 3).every(({ status, code }) => status === 503 && code === "UPSTREAM_UNAVAILABLE"));
  assert.match(failures[3].message, /circuit is open/);
  const readiness = await fetch(`http://127.0.0.1:${appPort}/health/ready`);
  assert.equal(readiness.status, 503);

  const eventTarget = createServer((_request, response) => { response.statusCode = 503; response.end(); });
  const eventPort = await listen(eventTarget); let deadLettered = false;
  const store = {
    claimOutbox: async () => [{ outbox_id: "fault-outbox-1", event: { specversion: "1.0", id: "evt-fault", type: "crm.command.committed.v1", source: "urn:fault", subject: "customer/1", time: new Date().toISOString(), tenant_id: "tenant_demo", request_id: "req-fault", data: {} } }],
    markOutboxPublished: async () => assert.fail("failed delivery must not be acknowledged"),
    markOutboxFailed: async () => { deadLettered = true; return { dead_lettered: true }; },
  };
  const relay = new OutboxRelay({ store, config: outboxConfig({ OUTBOX_TARGET_URL: `http://127.0.0.1:${eventPort}`, OUTBOX_TENANT_IDS: "tenant_demo", OUTBOX_MAX_ATTEMPTS: "1" }), workerId: "fault-worker" });
  const relayResult = await relay.runOnce();
  await new Promise((resolve) => eventTarget.close(resolve));
  assert.equal(deadLettered, true); assert.equal(relayResult.dead_lettered, 1);

  const evidence = { schema_version: "sumi.fault-drill.v1", observed_at: new Date().toISOString(), runtime: process.version, provider_timeout: { attempts: failures, circuit_open: true, readiness_status: readiness.status }, outbox: relayResult, passed: true };
  await mkdir("artifacts/release", { recursive: true });
  await writeFile("artifacts/release/fault-drill.json", `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally {
  app.kill(); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve));
}
