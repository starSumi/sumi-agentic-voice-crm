import assert from "node:assert/strict";
import test from "node:test";
import {
  OutboxRelay,
  outboxConfig,
  verifyOutboxSignature,
} from "../src/outbox-relay.ts";

type EventFixture = Readonly<{ id: string } & Record<string, unknown>>;
type StoreCall = [kind: "published" | "failed" | "released", value: unknown];
type PublishedRequest = {
  body: string;
  headers: Record<string, string>;
};

function fakeStore(event: EventFixture) {
  const calls: StoreCall[] = [];
  return {
    calls,
    claimOutbox: async () => [{ outbox_id: "out-1", attempts: 0, event }],
    markOutboxPublished: async (value: unknown) => {
      calls.push(["published", value]);
    },
    markOutboxFailed: async (
      value: {
        max_attempts: number;
      } & Record<string, unknown>,
    ) => {
      calls.push(["failed", value]);
      return { dead_lettered: value.max_attempts === 1 };
    },
    releaseOutboxLeases: async (
      value: {
        outbox_ids: string[];
      } & Record<string, unknown>,
    ) => {
      calls.push(["released", value]);
      return { released: value.outbox_ids.length };
    },
  };
}

const event = {
  specversion: "1.0",
  id: "evt-1",
  type: "crm.command.committed.v1",
  source: "urn:test",
  subject: "customer/1",
  time: new Date().toISOString(),
  tenant_id: "tenant-a",
  request_id: "req-1",
  data: {},
};

test("relay signs and acknowledges a successfully published CloudEvent", async () => {
  const store = fakeStore(event);
  let request: PublishedRequest | undefined;
  const config = outboxConfig({
    OUTBOX_TARGET_URL: "https://events.example.test/hook",
    OUTBOX_TENANT_IDS: "tenant-a",
    OUTBOX_HMAC_SECRET: "secret",
  });
  const relay = new OutboxRelay({
    store,
    config,
    fetchImpl: async (_url: string, options: RequestInit) => {
      assert.equal(typeof options.body, "string");
      if (typeof options.body !== "string")
        throw new TypeError("expected request body");
      request = {
        body: options.body,
        headers: Object.fromEntries(new Headers(options.headers)),
      };
      return { ok: true, status: 204 };
    },
    workerId: "worker-a",
  });
  assert.deepEqual(await relay.runOnce(), {
    claimed: 1,
    published: 1,
    failed: 0,
    dead_lettered: 0,
  });
  assert.ok(request);
  assert.equal(
    verifyOutboxSignature(
      request.body,
      request.headers["x-sumi-signature"],
      "secret",
    ),
    true,
  );
  assert.equal(request.headers["idempotency-key"], event.id);
  assert.equal(store.calls.at(0)?.[0], "published");
});

test("relay cancellation releases claimed rows without consuming attempts", async () => {
  const store = fakeStore(event);
  const controller = new AbortController();
  const config = outboxConfig({
    OUTBOX_TARGET_URL: "https://events.example.test/hook",
    OUTBOX_TENANT_IDS: "tenant-a",
  });
  const relay = new OutboxRelay({
    store,
    config,
    fetchImpl: async (_url: string, options: RequestInit) => {
      const signal = options.signal;
      if (!signal) throw new TypeError("expected relay abort signal");
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    workerId: "worker-a",
  });
  const pending = relay.runOnce({ signal: controller.signal });
  controller.abort(
    Object.assign(new Error("shutdown"), { name: "AbortError" }),
  );
  await assert.rejects(pending, /shutdown/);
  assert.deepEqual(
    store.calls.map(([kind]) => kind),
    ["released"],
  );
});

test("relay schedules failures and moves exhausted events to dead letter", async () => {
  const store = fakeStore(event);
  const config = outboxConfig({
    OUTBOX_TARGET_URL: "https://events.example.test/hook",
    OUTBOX_TENANT_IDS: "tenant-a",
    OUTBOX_MAX_ATTEMPTS: "1",
  });
  const relay = new OutboxRelay({
    store,
    config,
    fetchImpl: async () => ({ ok: false, status: 503 }),
    workerId: "worker-a",
  });
  assert.deepEqual(await relay.runOnce(), {
    claimed: 1,
    published: 0,
    failed: 1,
    dead_lettered: 1,
  });
  assert.equal(store.calls[0][0], "failed");
});

test("an open target circuit releases the unattempted batch without consuming retries", async () => {
  const calls: string[][] = [];
  const rows = Array.from({ length: 5 }, (_, index) => ({
    outbox_id: `out-${index + 1}`,
    attempts: 0,
    event: { ...event, id: `evt-${index + 1}` },
  }));
  const store = {
    claimOutbox: async () => rows,
    markOutboxPublished: async () => {
      throw new Error("publish must fail");
    },
    markOutboxFailed: async (value: { outbox_id: string }) => {
      calls.push(["failed", value.outbox_id]);
      return { dead_lettered: false };
    },
    releaseOutboxLeases: async (value: { outbox_ids: string[] }) => {
      calls.push(["released", ...value.outbox_ids]);
      return { released: value.outbox_ids.length };
    },
  };
  const config = outboxConfig({
    OUTBOX_TARGET_URL: "https://events.example.test/hook",
    OUTBOX_TENANT_IDS: "tenant-a",
  });
  const relay = new OutboxRelay({
    store,
    config,
    fetchImpl: async () => ({ ok: false, status: 503 }),
    workerId: "worker-a",
  });

  assert.deepEqual(await relay.runOnce(), {
    claimed: 5,
    published: 0,
    failed: 3,
    dead_lettered: 0,
  });
  assert.deepEqual(calls, [
    ["failed", "out-1"],
    ["failed", "out-2"],
    ["failed", "out-3"],
    ["released", "out-4", "out-5"],
  ]);
});

test("production relay configuration requires HTTPS and an HMAC secret", () => {
  assert.throws(
    () =>
      outboxConfig({
        APP_ENV: "production",
        OUTBOX_TARGET_URL: "http://events.test",
        OUTBOX_TENANT_IDS: "tenant-a",
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      outboxConfig({
        APP_ENV: "production",
        OUTBOX_TARGET_URL: "https://events.test",
        OUTBOX_TENANT_IDS: "tenant-a",
      }),
    /HMAC/,
  );
  assert.throws(
    () =>
      outboxConfig({
        APP_ENV: "production",
        OUTBOX_TARGET_URL: "https://events.test",
        OUTBOX_TENANT_IDS: "tenant-a",
        OUTBOX_HMAC_SECRET: "short",
      }),
    /32 characters/,
  );
});
