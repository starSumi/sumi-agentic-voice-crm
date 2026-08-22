import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 18_000 + (process.pid % 1_000);
const child = spawn(process.execPath, ["dist/src/server.ts"], {
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
  assert.equal(readiness.dependencies.database.provider, "memory");
  assert.equal(readiness.dependencies.objects.provider, "memory");
  for (const provider of ["asr", "intent", "tts"]) {
    assert.equal(readiness.dependencies.providers?.[provider]?.provider, "mock");
    assert.equal(readiness.dependencies.providers?.[provider]?.ready, true);
  }
  console.log(
    `dist smoke passed: readiness is ${readiness.status} with memory development dependencies`,
  );
} finally {
  child.kill("SIGTERM");
}
