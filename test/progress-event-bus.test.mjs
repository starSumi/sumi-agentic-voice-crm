import assert from "node:assert/strict";
import test from "node:test";
import {
  createProgressEventBus,
  ProgressBackpressureError,
} from "../src/application/progress-event-bus.ts";

function event(overrides = {}) {
  return {
    type: "interaction.started",
    request_id: "req_progress_bus",
    tenant_id: "tenant_a",
    actor_id: "actor_a",
    occurred_at: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

test("progress bus fans one event out to tenant-scoped subscribers", async () => {
  const bus = createProgressEventBus();
  const byRequest = bus.subscribe({ tenantId: "tenant_a", requestId: "req_progress_bus" });
  const byTenant = bus.subscribe({ tenantId: "tenant_a" });
  const controller = new AbortController();
  const otherTenant = bus.subscribe({ tenantId: "tenant_b", signal: controller.signal });

  assert.equal(bus.emit(event()), 2);
  assert.deepEqual((await byRequest.next()).value, event());
  assert.deepEqual((await byTenant.next()).value, event());

  const pending = otherTenant.next();
  controller.abort(Object.assign(new Error("subscription cancelled"), { name: "AbortError" }));
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(await otherTenant.next(), { done: true, value: undefined });
  bus.close();
});

test("progress bus bounds slow consumers without affecting other subscribers", async () => {
  const bus = createProgressEventBus({ defaultCapacity: 1 });
  const slow = bus.subscribe({ tenantId: "tenant_a" });
  const fast = bus.subscribe({ tenantId: "tenant_a" });

  bus.emit(event({ type: "one" }));
  assert.equal((await fast.next()).value.type, "one");
  bus.emit(event({ type: "two" }));
  assert.equal((await fast.next()).value.type, "two");

  await assert.rejects(slow.next(), (error) => error instanceof ProgressBackpressureError);
  assert.deepEqual(await slow.next(), { done: true, value: undefined });
  bus.close();
});

test("progress bus closes waiting subscriptions through its lifecycle hook", async () => {
  const bus = createProgressEventBus();
  const subscription = bus.subscribe({ tenantId: "tenant_a" });
  const pending = subscription.next();
  bus.close();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.equal(bus.closed, true);
});
