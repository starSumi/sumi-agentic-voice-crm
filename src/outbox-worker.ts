import { fileURLToPath } from "node:url";
import { createControlEngine, DEFAULT_TEARDOWN_TIMEOUT_MS, type ControlEngine } from "./control/index.ts";
import { createPostgresStore } from "./postgres-store.ts";
import { OutboxRelay, outboxConfig } from "./outbox-relay.ts";
import { validateProductionConfig } from "./production-config.ts";

type AnyRecord = Record<string, any>;
type WorkerTask = { result: Promise<void> };
type WorkerStore = AnyRecord;
type WorkerConfig = ReturnType<typeof outboxConfig>;

function teardownTimeout(env: NodeJS.ProcessEnv): number {
  const value = Number(env.RUNTIME_TEARDOWN_MS || DEFAULT_TEARDOWN_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 30_000) {
    throw new Error("RUNTIME_TEARDOWN_MS must be a positive integer no greater than 30000");
  }
  return value;
}

async function waitForPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(undefined);
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

export function createOutboxWorker({ store, relay, control, config }: { store?: WorkerStore; relay?: OutboxRelay; control?: ControlEngine; config?: WorkerConfig } = {}) {
  if (!store || !relay || !control || !config) throw new TypeError("outbox worker requires store, relay, control and config");
  const durableStore = store;
  const durableRelay = relay;
  const runtimeControl = control;
  const workerConfig = config;
  let task: WorkerTask | undefined;
  let closePromise: Promise<void> | undefined;

  async function loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const result = await durableRelay.runOnce({ signal });
      if (result.claimed === 0) await waitForPoll(signal, workerConfig.pollIntervalMs);
    }
  }

  async function start() {
    if (task) return task;
    await runtimeControl.start();
    task = runtimeControl.tasks.start("outbox.poll", loop);
    return task;
  }

  function close(reason?: unknown): Promise<void> {
    closePromise ??= (async () => {
      const errors = [];
      try { await runtimeControl.close({ reason }); } catch (error: unknown) { errors.push(error); }
      try { await durableStore.close(); } catch (error: unknown) { errors.push(error); }
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

export function createConfiguredOutboxWorker({ env = process.env, onResult }: { env?: NodeJS.ProcessEnv; onResult?: (result: AnyRecord) => void } = {}) {
  validateProductionConfig(env, { component: "outbox" });
  const store = createPostgresStore({ env });
  const config = outboxConfig(env);
  const control = createControlEngine({ teardownTimeoutMs: teardownTimeout(env) });
  const relay = new OutboxRelay({
    store,
    config,
    control,
    onResult: onResult ?? ((result: AnyRecord) => console.log(JSON.stringify({
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
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      closing = true;
      void worker.close(Object.assign(new Error(`${signal} received`), {
        name: "AbortError",
        breakerEligible: false,
      })).catch((error: unknown) => {
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
