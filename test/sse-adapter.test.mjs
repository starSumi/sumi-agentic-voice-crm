import assert from "node:assert/strict";
import test from "node:test";
import { createSseResponse, encodeSseComment, encodeSseEvent } from "../src/sse-adapter.mjs";

const decode = (bytes) => new TextDecoder().decode(bytes);

test("SSE adapter emits AG-UI-compatible data-only JSON frames", async () => {
  assert.equal(decode(encodeSseEvent({ type: "RUN_STARTED", runId: "run-1" })), 'data: {"type":"RUN_STARTED","runId":"run-1"}\n\n');
  assert.equal(decode(encodeSseComment("client\nready")), ":client ready\n\n");
  const response = createSseResponse({
    events: (async function* () {
      yield { type: "RUN_STARTED", runId: "run-1" };
      yield { type: "RUN_FINISHED", runId: "run-1" };
    })(),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(await response.text(), 'data: {"type":"RUN_STARTED","runId":"run-1"}\n\ndata: {"type":"RUN_FINISHED","runId":"run-1"}\n\n');
});

test("SSE adapter applies a future event guard and closes on request abort", async () => {
  const request = new Request("http://sumi.invalid/v1/ag-ui", { signal: AbortSignal.timeout(1000) });
  const response = createSseResponse({
    request,
    events: (async function* () {
      yield { type: "PUBLIC_STATUS", status: "awaiting_review" };
    })(),
    eventGuard(event) {
      if (event.type === "MODEL_CHAIN_OF_THOUGHT") throw new Error("private event rejected");
      return event;
    },
  });
  assert.match(await response.text(), /PUBLIC_STATUS/);
  assert.throws(() => encodeSseEvent("not-an-event"), /must be an object/);
});
