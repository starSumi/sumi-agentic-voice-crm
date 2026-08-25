import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { OutboxRelay, outboxConfig } from "../src/outbox-relay.ts";
import { createProviderRuntime } from "../src/providers.ts";
import { isolatedDrillEnv } from "./drill-env.ts";

function agentCrmEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ASR_PROVIDER: "mock",
    INTENT_PROVIDER: "agent-crm-http",
    TTS_PROVIDER: "mock",
    AGENT_CRM_HTTP_URL: "https://agent-crm.example.test/chat?variant=fine",
    AGENT_CRM_HTTP_MODEL: "sumi.agent-crm-training-example.v1",
    AGENT_CRM_HTTP_CALLER_ID:
      "sumi-caller-00000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

async function runAgentCrmFaultMatrix() {
  const neutral = createProviderRuntime({
    env: agentCrmEnv({ AGENT_CRM_HTTP_BEARER_TOKEN: "fault-drill-token" }),
    fetchImpl: async (_input, init = {}) => {
      assert.equal(init.redirect, "error");
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer fault-drill-token",
      );
      return new Response("sensitive upstream detail", { status: 400 });
    },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(
      () => neutral.understand("synthetic query", { locale: "en-US" }),
      (error: unknown) => {
        const candidate = error as Error & {
          code?: string;
          breakerEligible?: boolean;
        };
        return (
          candidate.code === "PROVIDER_REJECTED" &&
          candidate.breakerEligible === false &&
          !candidate.message.includes("sensitive upstream detail") &&
          !JSON.stringify(candidate).includes("fault-drill-token")
        );
      },
    );
  }

  const eligible: Record<string, { calls: number; circuit: string }> = {};
  for (const status of [429, 503]) {
    let calls = 0;
    const runtime = createProviderRuntime({
      env: agentCrmEnv(),
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status });
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(() =>
        runtime.understand("synthetic query", { locale: "en-US" }),
      );
    }
    await assert.rejects(
      () => runtime.understand("synthetic query", { locale: "en-US" }),
      /circuit is open/u,
    );
    eligible[String(status)] = {
      calls,
      circuit: runtime.providerReadiness().statuses.intent.circuit,
    };
  }

  const redirect = createProviderRuntime({
    env: agentCrmEnv(),
    fetchImpl: async (_input, init = {}) => {
      assert.equal(init.redirect, "error");
      return new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.example.test/chat" },
      });
    },
  });
  await assert.rejects(
    () => redirect.understand("synthetic query", { locale: "en-US" }),
    (error: unknown) =>
      (error as { breakerEligible?: boolean }).breakerEligible === false,
  );

  const malformed = createProviderRuntime({
    env: agentCrmEnv(),
    fetchImpl: async (_input, init = {}) => {
      const request = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          request_id: request.request_id,
          phone_number: request.phone_number,
          response: "not-json",
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  await assert.rejects(() =>
    malformed.understand("synthetic query", { locale: "en-US" }),
  );

  const timed = createProviderRuntime({
    env: agentCrmEnv({
      PROVIDER_SOFT_TIMEOUT_MS: "20",
      PROVIDER_HARD_GRACE_MS: "20",
    }),
    fetchImpl: async (_input, init = {}) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        assert.ok(signal);
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
  });
  await assert.rejects(
    () => timed.understand("synthetic query", { locale: "en-US" }),
    (error: unknown) =>
      (error as { name?: string }).name === "StagedTimeoutError",
  );

  return {
    four_xx_neutral:
      neutral.providerReadiness().statuses.intent.circuit === "closed",
    breaker_eligible: eligible,
    redirect_neutral:
      redirect.providerReadiness().statuses.intent.circuit === "closed",
    malformed_rejected: true,
    timeout_cooperative: true,
  };
}

async function listen(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("failed to resolve server port"));
      resolve(address.port);
    });
  });
}

const provider = createServer(() => {});
const providerPort = await listen(provider);
const portProbe = createServer();
const appPort = await listen(portProbe);
await new Promise((resolve) => portProbe.close(resolve));
const app = spawn(process.execPath, ["src/server.ts"], {
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
let diagnostics = "";
app.stderr.on("data", (data) => {
  diagnostics += data;
});
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`fault target startup timed out: ${diagnostics}`)),
    10_000,
  );
  app.stdout.on("data", (data) => {
    if (String(data).includes(`:${appPort}`)) {
      clearTimeout(timer);
      resolve();
    }
  });
  app.once("exit", (code) =>
    reject(new Error(`fault target exited with ${code}: ${diagnostics}`)),
  );
});

const failures = [];
try {
  for (let index = 0; index < 4; index += 1) {
    const response = await fetch(`http://127.0.0.1:${appPort}/v1/ask`, {
      method: "POST",
      headers: {
        authorization: "Bearer fault-actor",
        "x-tenant-id": "tenant_demo",
        "idempotency-key": `fault-intent-${index}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: { type: "text", text: "find customer" },
        output_mode: "text",
        locale: "en-US",
      }),
    });
    const body = await response.json();
    failures.push({
      status: response.status,
      code: body.error?.code,
      message: body.error?.message,
    });
  }
  assert.ok(
    failures
      .slice(0, 3)
      .every(
        ({ status, code }) => status === 503 && code === "UPSTREAM_UNAVAILABLE",
      ),
  );
  assert.match(failures[3].message, /circuit is open/);
  const readiness = await fetch(`http://127.0.0.1:${appPort}/health/ready`);
  assert.equal(readiness.status, 503);

  const eventTarget = createServer((_request, response) => {
    response.statusCode = 503;
    response.end();
  });
  const eventPort = await listen(eventTarget);
  let deadLettered = false;
  const store = {
    claimOutbox: async () => [
      {
        outbox_id: "fault-outbox-1",
        event: {
          specversion: "1.0",
          id: "evt-fault",
          type: "crm.command.committed.v1",
          source: "urn:fault",
          subject: "customer/1",
          time: new Date().toISOString(),
          tenant_id: "tenant_demo",
          request_id: "req-fault",
          data: {},
        },
      },
    ],
    markOutboxPublished: async () =>
      assert.fail("failed delivery must not be acknowledged"),
    markOutboxFailed: async () => {
      deadLettered = true;
      return { dead_lettered: true };
    },
  };
  const relay = new OutboxRelay({
    store,
    config: outboxConfig({
      OUTBOX_TARGET_URL: `http://127.0.0.1:${eventPort}`,
      OUTBOX_TENANT_IDS: "tenant_demo",
      OUTBOX_MAX_ATTEMPTS: "1",
    }),
    workerId: "fault-worker",
  });
  const relayResult = await relay.runOnce();
  await new Promise((resolve) => eventTarget.close(resolve));
  assert.equal(deadLettered, true);
  assert.equal(relayResult.dead_lettered, 1);
  const agentCrmHttp = await runAgentCrmFaultMatrix();

  const evidence = {
    schema_version: "sumi.fault-drill.v1",
    observed_at: new Date().toISOString(),
    runtime: process.version,
    provider_timeout: {
      attempts: failures,
      circuit_open: true,
      readiness_status: readiness.status,
    },
    agent_crm_http: agentCrmHttp,
    outbox: relayResult,
    passed: true,
  };
  await mkdir("artifacts/release", { recursive: true });
  await writeFile(
    "artifacts/release/fault-drill.json",
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence));
} finally {
  app.kill();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
}
