import assert from "node:assert/strict";
import test from "node:test";
import { CasCircuitBreaker, createControlEngine } from "../src/control/index.mjs";

const eligible = () => Object.assign(new Error("upstream failed"), { breakerEligible: true });

test("CAS circuit aggregates concurrent failures without stale state overwrite", async () => {
  const breaker = new CasCircuitBreaker({ threshold: 3, cooldownMs: 100 });
  await Promise.allSettled([1, 2, 3].map(() => breaker.run(async () => { throw eligible(); })));
  const snapshot = breaker.snapshot();
  assert.equal(snapshot.state, "open");
  assert.equal(snapshot.failures, 3);
  await assert.rejects(breaker.run(async () => "unexpected"), /circuit is open/);
});

test("CAS half-open state admits one probe and ignores stale completions", async () => {
  let clock = 0;
  const breaker = new CasCircuitBreaker({ threshold: 1, cooldownMs: 10, now: () => clock });
  await assert.rejects(breaker.run(async () => { throw eligible(); }));
  clock = 11;
  let release;
  const probe = breaker.run(() => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(breaker.run(async () => "second"), /circuit is open/);
  release("recovered");
  assert.equal(await probe, "recovered");
  assert.equal(breaker.snapshot().state, "closed");
});

test("CAS ignores a closed permit from an older recovery epoch", async () => {
  let clock = 0;
  const breaker = new CasCircuitBreaker({ threshold: 1, cooldownMs: 10, now: () => clock });
  let rejectStale;
  const stale = breaker.run(() => new Promise((_, reject) => { rejectStale = reject; }));
  await assert.rejects(breaker.run(async () => { throw eligible(); }));
  clock = 11;
  assert.equal(await breaker.run(async () => "recovered"), "recovered");
  rejectStale(eligible());
  await assert.rejects(stale);
  assert.equal(breaker.snapshot().state, "closed");
  assert.equal(breaker.snapshot().failures, 0);
});

test("a neutral half-open probe reopens for a bounded cooldown", async () => {
  let clock = 0;
  const breaker = new CasCircuitBreaker({ threshold: 1, cooldownMs: 10, now: () => clock });
  await assert.rejects(breaker.run(async () => { throw eligible(); }));
  clock = 11;
  await assert.rejects(breaker.run(async () => {
    throw Object.assign(new Error("caller cancelled"), { breakerEligible: false });
  }));
  assert.equal(breaker.snapshot().state, "open");
  clock = 22;
  assert.equal(await breaker.run(async () => "healthy"), "healthy");
});

test("parent cancellation is neutral to the control circuit", async () => {
  const engine = createControlEngine();
  const parent = new AbortController();
  const pending = engine.run("provider.intent.cancelled", (signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { signal: parent.signal, softTimeoutMs: 100, hardGraceMs: 10 });
  parent.abort(new Error("client disconnected"));
  await assert.rejects(pending, (error) => error.breakerEligible === false);
  assert.equal(engine.snapshot()["provider.intent.cancelled"].failures, 0);
});

test("parent cancellation stays neutral when the operation ignores cooperative abort", async () => {
  const engine = createControlEngine();
  const parent = new AbortController();
  let started;
  const operationStarted = new Promise((resolve) => { started = resolve; });
  const pending = engine.run("provider.intent.stuck-cancel", () => {
    started();
    return new Promise(() => {});
  }, {
    signal: parent.signal,
    softTimeoutMs: 1_000,
    hardGraceMs: 5,
    breaker: { threshold: 1, cooldownMs: 100 },
  });
  await operationStarted;
  parent.abort(new Error("client disconnected"));
  await assert.rejects(pending, (error) =>
    error.phase === "hard" &&
    error.breakerEligible === false &&
    error.cause?.name === "AbortError",
  );
  assert.deepEqual(engine.snapshot()["provider.intent.stuck-cancel"], {
    state: "closed",
    failures: 0,
    version: 0,
  });
});

test("control engine applies staged timeout through the keyed circuit", async () => {
  const engine = createControlEngine();
  await assert.rejects(
    engine.run("provider.intent.test", () => new Promise(() => {}), {
      softTimeoutMs: 5,
      hardGraceMs: 5,
    }),
    (error) => error.phase === "hard" && error.code === "UPSTREAM_UNAVAILABLE",
  );
  assert.equal(engine.snapshot()["provider.intent.test"].failures, 1);
});

test("control engine owns managed tasks and closes them before extensions", async () => {
  const lifecycle = [];
  const extensions = {
    startAll: async () => lifecycle.push("extensions:start"),
    close: async () => lifecycle.push("extensions:close"),
  };
  const engine = createControlEngine({ extensions, teardownTimeoutMs: 50 });
  await engine.start();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  engine.tasks.start("worker", async (signal) => {
    started();
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => {
      lifecycle.push("task:stop");
      reject(signal.reason);
    }, { once: true }));
  });
  await ready;
  await engine.close();
  assert.deepEqual(lifecycle, ["extensions:start", "task:stop", "extensions:close"]);
  assert.equal(engine.taskSnapshot().state, "closed");
});
