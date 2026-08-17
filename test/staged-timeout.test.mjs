import assert from "node:assert/strict";
import test from "node:test";
import { runWithStagedTimeout, StagedTimeoutError } from "../src/lifecycle/staged-timeout.mjs";

test("staged timeout requests cooperative abort before the hard deadline", async () => {
  let observedAbort = false;
  await assert.rejects(
    runWithStagedTimeout((signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(signal.reason);
      }, { once: true });
    }), { softTimeoutMs: 10, hardGraceMs: 30, label: "cooperative" }),
    (error) => error instanceof StagedTimeoutError && error.phase === "soft",
  );
  assert.equal(observedAbort, true);
});

test("staged timeout invokes the hard-stop hook when cleanup ignores abort", async () => {
  let hardStops = 0;
  await assert.rejects(
    runWithStagedTimeout(() => new Promise(() => {}), {
      softTimeoutMs: 5,
      hardGraceMs: 5,
      label: "isolated extension",
      onHardTimeout: () => { hardStops += 1; },
    }),
    (error) => error instanceof StagedTimeoutError && error.phase === "hard",
  );
  assert.equal(hardStops, 1);
});

test("a parent AbortSignal is propagated without waiting for the soft deadline", async () => {
  const parent = new AbortController();
  const reason = Object.assign(new Error("request closed"), { code: "UPSTREAM_UNAVAILABLE" });
  const pending = runWithStagedTimeout((signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { signal: parent.signal, softTimeoutMs: 1_000, hardGraceMs: 20 });
  parent.abort(reason);
  await assert.rejects(pending, (error) =>
    error.name === "AbortError" &&
    error.breakerEligible === false &&
    error.cause === reason,
  );
});

test("a rejected asynchronous hard-stop hook is contained", async () => {
  await assert.rejects(
    runWithStagedTimeout(() => new Promise(() => {}), {
      softTimeoutMs: 5,
      hardGraceMs: 5,
      onHardTimeout: async () => { throw new Error("terminate failed"); },
    }),
    (error) => error instanceof StagedTimeoutError && error.phase === "hard",
  );
  await new Promise((resolve) => setImmediate(resolve));
});

test("a rejected asynchronous soft-timeout hook is contained", async () => {
  await assert.rejects(
    runWithStagedTimeout((signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), {
      softTimeoutMs: 5,
      hardGraceMs: 20,
      onSoftTimeout: async () => { throw new Error("soft hook failed"); },
    }),
    (error) => error instanceof StagedTimeoutError && error.phase === "soft",
  );
  await new Promise((resolve) => setImmediate(resolve));
});
