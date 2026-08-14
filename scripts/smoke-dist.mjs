import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 18_000 + (process.pid % 1_000);
const child = spawn(process.execPath, ["dist/src/server.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

try {
  let response;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.ok) break;
    } catch {
      // The process may still be binding its listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(response?.ok, `readiness failed: ${stderr.join("")}`);
  const readiness = await response.json();
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.mode, "mock");
  assert.deepEqual(readiness.providers, {
    asr: "mock",
    intent: "mock",
    tts: "mock",
  });
  console.log(
    `dist smoke passed: readiness is ${readiness.status} in ${readiness.mode} mode`,
  );
} finally {
  child.kill("SIGTERM");
}
