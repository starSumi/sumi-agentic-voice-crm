import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { isolatedDrillEnv } from "./drill-env.ts";

const requests = Number(process.env.DRILL_REQUESTS || 250);
const concurrency = Number(process.env.DRILL_CONCURRENCY || 25);
const p95LimitMs = Number(process.env.DRILL_P95_LIMIT_MS || 500);
const errorRateLimit = Number(process.env.DRILL_ERROR_RATE_LIMIT || 0);
for (const [name, value] of Object.entries({
  DRILL_REQUESTS: requests,
  DRILL_CONCURRENCY: concurrency,
})) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000)
    throw new Error(`${name} must be an integer between 1 and 1000000`);
}
if (!Number.isFinite(p95LimitMs) || p95LimitMs < 1)
  throw new Error("DRILL_P95_LIMIT_MS must be positive");
if (!Number.isFinite(errorRateLimit) || errorRateLimit < 0 || errorRateLimit > 1)
  throw new Error("DRILL_ERROR_RATE_LIMIT must be between 0 and 1");

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("failed to resolve free port"));
      server.close(() => resolve((address as AddressInfo).port));
    });
  });
}

async function startLocal() {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.ts"], {
    env: isolatedDrillEnv({
      PORT: String(port),
      APP_ENV: "test",
      AUTH_MODE: "development",
      STORE_PROVIDER: "memory",
      OBJECT_STORAGE_PROVIDER: "memory",
      ASR_PROVIDER: "mock",
      INTENT_PROVIDER: "mock",
      TTS_PROVIDER: "mock",
      RATE_LIMIT_WINDOW_MS: "60000",
      RATE_LIMIT_MAX_REQUESTS: String(requests),
      RATE_LIMIT_MAX_KEYS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (data) => {
    diagnostics += data;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`load target startup timed out: ${diagnostics}`)),
      10_000,
    );
    child.stdout.on("data", (data) => {
      if (String(data).includes(`:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) =>
      reject(new Error(`load target exited with ${code}: ${diagnostics}`)),
    );
  });
  return { baseUrl: `http://127.0.0.1:${port}`, child };
}

const local = process.env.DRILL_BASE_URL ? undefined : await startLocal();
const baseUrl = (process.env.DRILL_BASE_URL || local?.baseUrl || "").replace(
  /\/$/,
  "",
);
const durations: number[] = [];
const failures: Array<Record<string, unknown>> = [];
let cursor = 0;
async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= requests) return;
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}/v1/ask`, {
        method: "POST",
        headers: {
          authorization: process.env.DRILL_AUTHORIZATION || "Bearer load-actor",
          "x-tenant-id": process.env.DRILL_TENANT_ID || "tenant_demo",
          "idempotency-key": `load-${Date.now()}-${index}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: { type: "text", text: "find records" },
          output_mode: "text",
          locale: "en-US",
        }),
        signal: AbortSignal.timeout(
          Number(process.env.DRILL_REQUEST_TIMEOUT_MS || 5_000),
        ),
      });
      if (response.status !== 200)
        failures.push({ index, status: response.status });
      await response.arrayBuffer();
    } catch (error) {
      failures.push({
        index,
        error: error instanceof Error ? error.name : "request_failed",
      });
    }
    durations.push(performance.now() - started);
  }
}

try {
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests) }, () => worker()),
  );
} finally {
  if (local?.child) local.child.kill();
}
durations.sort((a, b) => a - b);
const percentile = (p: number) =>
  Number(
    durations[
      Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)
    ]?.toFixed(2) ?? "0",
  );
const evidence = {
  schema_version: "sumi.load-drill.v1",
  observed_at: new Date().toISOString(),
  target: process.env.DRILL_BASE_URL ? "configured" : "local-ephemeral",
  runtime: process.version,
  requests,
  concurrency,
  succeeded: requests - failures.length,
  failed: failures.length,
  error_rate: failures.length / requests,
  latency_ms: {
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: Number((durations.at(-1) ?? 0).toFixed(2)),
  },
  thresholds: { p95_ms: p95LimitMs, error_rate: errorRateLimit },
  passed:
    failures.length / requests <= errorRateLimit &&
    percentile(0.95) <= p95LimitMs,
};
await mkdir("artifacts/release", { recursive: true });
await writeFile(
  "artifacts/release/load-drill.json",
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence));
if (!evidence.passed) process.exitCode = 1;
