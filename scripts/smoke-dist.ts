import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = 18_000 + (process.pid % 1_000);
const child = spawn(process.execPath, ["dist/src/server.ts"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const stderr: string[] = [];
child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
let closed = false;
const childClosed = new Promise<void>((resolve) => {
  child.once("close", () => {
    closed = true;
    resolve();
  });
});
child.once("error", (error) => stderr.push(error.message));

try {
  let response;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (closed) break;
    try {
      response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) break;
    } catch {
      // The process may still be binding its listener.
    }
    await delay(100);
  }

  assert.ok(response?.ok, `readiness failed: ${stderr.join("")}`);
  const readiness = await response.json();
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.dependencies.database.provider, "memory");
  assert.equal(readiness.dependencies.objects.provider, "memory");
  for (const provider of ["asr", "intent", "tts"]) {
    assert.equal(
      readiness.dependencies.providers?.[provider]?.provider,
      "mock",
    );
    assert.equal(readiness.dependencies.providers?.[provider]?.ready, true);
  }
  console.log(
    `dist smoke passed: readiness is ${readiness.status} with memory development dependencies`,
  );
} finally {
  if (!closed) child.kill("SIGTERM");
  const graceful = Symbol("graceful-timeout");
  const outcome = await Promise.race([
    childClosed.then(() => undefined),
    delay(3_000, graceful, { ref: false }),
  ]);
  if (outcome === graceful && !closed) {
    child.kill("SIGKILL");
    await childClosed;
  }
}
