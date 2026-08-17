import { fileURLToPath } from "node:url";
import { createControlEngine, DEFAULT_TEARDOWN_TIMEOUT_MS } from "./control/index.mjs";
import { createPostgresStore } from "./postgres-store.mjs";
import { OutboxRelay, outboxConfig } from "./outbox-relay.mjs";
import { validateProductionConfig } from "./production-config.mjs";

function teardownTimeout(env) {
  const value = Number(env.RUNTIME_TEARDOWN_MS || DEFAULT_TEARDOWN_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 30_000) {
    throw new Error("RUNTIME_TEARDOWN_MS must be a positive integer no greater than 30000");
  }
  return value;
}

async function waitForPoll(signal, delayMs) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createOutboxWorker({ store, relay, control, config } = {}) {
  if (!store || !relay || !control || !config) throw new TypeError("outbox worker requires store, relay, control and config");
  let task;
  let closePromise;

  async function loop(signal) {
    while (!signal.aborted) {
      const result = await relay.runOnce({ signal });
      if (result.claimed === 0) await waitForPoll(signal, config.pollIntervalMs);
    }
  }

  async function start() {
    if (task) return task;
    await control.start();
    task = control.tasks.start("outbox.poll", loop);
    return task;
  }

  function close(reason) {
    closePromise ??= (async () => {
      const errors = [];
      try { await control.close({ reason }); } catch (error) { errors.push(error); }
      try { await store.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "outbox worker shutdown failed");
    })();
    return closePromise;
  }

  return Object.freeze({
    start,
    close,
    get task() { return task; },
  });
}

export function createConfiguredOutboxWorker({ env = process.env, onResult } = {}) {
  validateProductionConfig(env, { component: "outbox" });
  const store = createPostgresStore({ env });
  const config = outboxConfig(env);
  const control = createControlEngine({ teardownTimeoutMs: teardownTimeout(env) });
  const relay = new OutboxRelay({
    store,
    config,
    control,
    onResult: onResult ?? ((result) => console.log(JSON.stringify({
      level: result.status === "published" ? "info" : "warn",
      component: "outbox-relay",
      ...result,
      time: new Date().toISOString(),
    }))),
  });
  return createOutboxWorker({ store, relay, control, config });
}

async function main() {
  const worker = createConfiguredOutboxWorker();
  const task = await worker.start();
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      closing = true;
      void worker.close(Object.assign(new Error(`${signal} received`), {
        name: "AbortError",
        breakerEligible: false,
      })).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  }
  try {
    await task.result;
  } catch (error) {
    if (!closing) throw error;
  } finally {
    await worker.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
