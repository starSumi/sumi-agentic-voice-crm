import assert from "node:assert/strict";
import test from "node:test";
import { selectTransport, sendWithFallback } from "../packages/api-client/src/transport.ts";

test("transport selection prefers browser capabilities and keeps HTTP as fallback", () => {
  assert.equal(selectTransport({ capabilities: { webtransport: true, websocket: true } }), "webtransport");
  assert.equal(selectTransport({ capabilities: { websocket: true } }), "websocket");
  assert.equal(selectTransport({ capabilities: {} }), "http");
  assert.equal(selectTransport({ capabilities: { grpc: true }, preferred: ["grpc", "http"], allowGrpc: false }), "http");
  assert.equal(selectTransport({ capabilities: { grpc: true }, clientScope: "browser", preferred: ["grpc", "http"], allowGrpc: true }), "http");
  assert.equal(selectTransport({ capabilities: { grpc: true }, clientScope: "service", allowGrpc: true }), "grpc");
});

test("transport fallback retries availability failures but preserves application errors", async () => {
  const calls = [];
  const result = await sendWithFallback(
    { request_id: "req_1" },
    [
      {
        kind: "webtransport",
        send: async () => {
          calls.push("webtransport");
          throw Object.assign(new Error("connection failed"), { code: "TRANSPORT_CONNECT_FAILED" });
        },
      },
      {
        kind: "websocket",
        send: async () => {
          calls.push("websocket");
          return { ok: true };
        },
      },
    ],
  );
  assert.deepEqual(calls, ["webtransport", "websocket"]);
  assert.deepEqual(result, { ok: true });

  await assert.rejects(
    sendWithFallback(
      {},
      [{ kind: "webtransport", send: async () => { throw new Error("application rejected"); } }],
    ),
    /application rejected/,
  );
});
