export const DEFAULT_TEARDOWN_TIMEOUT_MS = 3_000;

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function abortReason(value, fallback = "managed task was stopped") {
  if (value instanceof Error) return value;
  return Object.assign(new Error(typeof value === "string" ? value : fallback), {
    name: "AbortError",
    breakerEligible: false,
  });
}

export class ManagedTaskTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`managed task ${name} did not stop within ${timeoutMs}ms`);
    this.name = "ManagedTaskTimeoutError";
    this.code = "TASK_TEARDOWN_TIMEOUT";
    this.task = name;
    this.timeout_ms = timeoutMs;
    this.breakerEligible = false;
  }
}

/**
 * Owns cooperative background work. A terminate hook is only a kill boundary
 * when it is supplied by a supervisor for an isolated process or worker.
 */
export class ManagedTaskRegistry {
  #tasks = new Map();
  #state = "open";
  #closePromise;

  constructor({ teardownTimeoutMs = DEFAULT_TEARDOWN_TIMEOUT_MS, now = () => Date.now() } = {}) {
    this.teardownTimeoutMs = positiveInteger(
      teardownTimeoutMs,
      DEFAULT_TEARDOWN_TIMEOUT_MS,
      "teardownTimeoutMs",
    );
    this.now = now;
  }

  get state() { return this.#state; }

  start(name, operation, { signal: parentSignal, terminate } = {}) {
    if (this.#state !== "open") throw new Error(`managed task registry cannot start from ${this.#state}`);
    if (typeof name !== "string" || !name.trim()) throw new TypeError("managed task name is required");
    if (typeof operation !== "function") throw new TypeError("managed task operation must be a function");
    if (terminate !== undefined && typeof terminate !== "function") throw new TypeError("managed task terminate must be a function");
    if (this.#tasks.has(name)) throw new Error(`managed task ${name} is already active`);

    const controller = new AbortController();
    const record = {
      name,
      controller,
      terminate,
      status: "running",
      started_at_ms: this.now(),
      settled_at_ms: undefined,
      terminationRequested: false,
    };
    const onParentAbort = () => {
      if (!controller.signal.aborted) controller.abort(abortReason(parentSignal.reason));
    };
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

    this.#tasks.set(name, record);
    record.result = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      })
      .then(
        (value) => {
          record.status = controller.signal.aborted ? "cancelled" : "completed";
          return value;
        },
        (error) => {
          record.status = controller.signal.aborted ? "cancelled" : "failed";
          record.error = error;
          throw error;
        },
      )
      .finally(() => {
        record.settled_at_ms = this.now();
        parentSignal?.removeEventListener("abort", onParentAbort);
        if (this.#tasks.get(name) === record) this.#tasks.delete(name);
      });
    // Registry ownership means an ignored task result never becomes an
    // unhandled rejection. Callers may still await handle.result or join().
    record.result.catch(() => {});

    return Object.freeze({
      name,
      signal: controller.signal,
      result: record.result,
      join: () => record.result,
      stop: (options) => this.#stopRecord(record, options),
      snapshot: () => this.#taskSnapshot(record),
    });
  }

  stop(name, options) {
    const record = this.#tasks.get(name);
    if (!record) return Promise.resolve(Object.freeze({ name, status: "not_found" }));
    return this.#stopRecord(record, options);
  }

  close({ reason, timeoutMs = this.teardownTimeoutMs } = {}) {
    if (this.#state === "closed") return Promise.resolve();
    if (this.#state === "closing") return this.#closePromise;
    this.#state = "closing";
    const records = [...this.#tasks.values()];
    this.#closePromise = (async () => {
      const results = await Promise.allSettled(records.map((record) => this.#stopRecord(record, {
        reason: abortReason(reason, "managed task registry is closing"),
        timeoutMs,
      })));
      this.#state = "closed";
      const errors = results.filter(({ status }) => status === "rejected").map(({ reason: error }) => error);
      if (errors.length) throw new AggregateError(errors, "managed task shutdown failed");
    })();
    return this.#closePromise;
  }

  snapshot() {
    return Object.freeze({
      state: this.#state,
      teardown_timeout_ms: this.teardownTimeoutMs,
      tasks: Object.freeze([...this.#tasks.values()].map((record) => this.#taskSnapshot(record))),
    });
  }

  async #stopRecord(record, { reason, timeoutMs = this.teardownTimeoutMs } = {}) {
    const resolvedTimeout = positiveInteger(timeoutMs, this.teardownTimeoutMs, "timeoutMs");
    if (!record.controller.signal.aborted) {
      record.status = "stopping";
      record.controller.abort(abortReason(reason));
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        record.status = "timed_out";
        if (!record.terminationRequested && record.terminate) {
          record.terminationRequested = true;
          Promise.resolve().then(() => record.terminate()).catch(() => {});
        }
        reject(new ManagedTaskTimeoutError(record.name, resolvedTimeout));
      }, resolvedTimeout);
    });
    try {
      await Promise.race([record.result, timeout]);
    } catch (error) {
      if (!record.controller.signal.aborted) throw error;
      if (error instanceof ManagedTaskTimeoutError) throw error;
    } finally {
      clearTimeout(timer);
    }
    return Object.freeze({ name: record.name, status: "stopped" });
  }

  #taskSnapshot(record) {
    return Object.freeze({
      name: record.name,
      status: record.status,
      started_at_ms: record.started_at_ms,
      settled_at_ms: record.settled_at_ms,
      supervised: typeof record.terminate === "function",
    });
  }
}

export function createManagedTaskRegistry(options) {
  return new ManagedTaskRegistry(options);
}
