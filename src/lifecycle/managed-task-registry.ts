export const DEFAULT_TEARDOWN_TIMEOUT_MS = 3_000;

type BreakerReason = Error & {
  breakerEligible?: boolean;
};

export type ManagedTaskStatus =
  | "running"
  | "stopping"
  | "timed_out"
  | "completed"
  | "cancelled"
  | "failed";

export interface ManagedTaskStartOptions {
  signal?: AbortSignal;
  terminate?: () => void | PromiseLike<void>;
}

export interface ManagedTaskStopOptions {
  reason?: unknown;
  timeoutMs?: number;
}

export interface ManagedTaskSnapshot {
  readonly name: string;
  readonly status: ManagedTaskStatus;
  readonly started_at_ms: number;
  readonly settled_at_ms?: number;
  readonly supervised: boolean;
}

export interface ManagedTaskStopResult {
  readonly name: string;
  readonly status: "stopped" | "not_found";
}

export interface ManagedTaskHandle<T> {
  readonly name: string;
  readonly signal: AbortSignal;
  readonly result: Promise<T>;
  join(): Promise<T>;
  stop(options?: ManagedTaskStopOptions): Promise<ManagedTaskStopResult>;
  snapshot(): ManagedTaskSnapshot;
}

type ManagedTaskRecord = {
  name: string;
  controller: AbortController;
  terminate?: () => void | PromiseLike<void>;
  status: ManagedTaskStatus;
  started_at_ms: number;
  settled_at_ms?: number;
  terminationRequested: boolean;
  result: Promise<unknown>;
  error?: unknown;
};

function positiveInteger(value: unknown, fallback: number, name: string): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function abortReason(value: unknown, fallback = "managed task was stopped"): BreakerReason {
  if (value instanceof Error) return value as BreakerReason;
  const reason = Object.assign(new Error(typeof value === "string" ? value : fallback), {
    name: "AbortError",
    breakerEligible: false,
  });
  return reason;
}

export class ManagedTaskTimeoutError extends Error {
  readonly code = "TASK_TEARDOWN_TIMEOUT";
  readonly task: string;
  readonly timeout_ms: number;
  readonly breakerEligible = false;

  constructor(name: string, timeoutMs: number) {
    super(`managed task ${name} did not stop within ${timeoutMs}ms`);
    this.name = "ManagedTaskTimeoutError";
    this.task = name;
    this.timeout_ms = timeoutMs;
  }
}

/**
 * Owns cooperative background work. A terminate hook is only a kill boundary
 * when it is supplied by a supervisor for an isolated process or worker.
 */
export class ManagedTaskRegistry {
  #tasks = new Map<string, ManagedTaskRecord>();
  #state: "open" | "closing" | "closed" = "open";
  #closePromise?: Promise<void>;

  readonly teardownTimeoutMs: number;
  readonly now: () => number;

  constructor({ teardownTimeoutMs = DEFAULT_TEARDOWN_TIMEOUT_MS, now = () => Date.now() }: {
    teardownTimeoutMs?: number;
    now?: () => number;
  } = {}) {
    this.teardownTimeoutMs = positiveInteger(
      teardownTimeoutMs,
      DEFAULT_TEARDOWN_TIMEOUT_MS,
      "teardownTimeoutMs",
    );
    this.now = now;
  }

  get state(): "open" | "closing" | "closed" { return this.#state; }

  start<T>(
    name: string,
    operation: (signal: AbortSignal) => T | PromiseLike<T>,
    { signal: parentSignal, terminate }: ManagedTaskStartOptions = {},
  ): ManagedTaskHandle<T> {
    if (this.#state !== "open") throw new Error(`managed task registry cannot start from ${this.#state}`);
    if (typeof name !== "string" || !name.trim()) throw new TypeError("managed task name is required");
    if (typeof operation !== "function") throw new TypeError("managed task operation must be a function");
    if (terminate !== undefined && typeof terminate !== "function") throw new TypeError("managed task terminate must be a function");
    if (this.#tasks.has(name)) throw new Error(`managed task ${name} is already active`);

    const controller = new AbortController();
    const record: ManagedTaskRecord = {
      name,
      controller,
      terminate,
      status: "running",
      started_at_ms: this.now(),
      terminationRequested: false,
      result: Promise.resolve(),
    };
    const onParentAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(abortReason(parentSignal?.reason));
    };
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

    this.#tasks.set(name, record);
    const result = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      })
      .then(
        (value) => {
          record.status = controller.signal.aborted ? "cancelled" : "completed";
          return value;
        },
        (error: unknown) => {
          record.status = controller.signal.aborted ? "cancelled" : "failed";
          record.error = error;
          throw error;
        },
      );
    record.result = result;
    result.finally(() => {
      record.settled_at_ms = this.now();
      parentSignal?.removeEventListener("abort", onParentAbort);
      if (this.#tasks.get(name) === record) this.#tasks.delete(name);
    }).catch(() => {});
    // Registry ownership means an ignored task result never becomes an
    // unhandled rejection. Callers may still await handle.result or join().
    result.catch(() => {});

    return Object.freeze({
      name,
      signal: controller.signal,
      result: result as Promise<T>,
      join: (): Promise<T> => result as Promise<T>,
      stop: (options?: ManagedTaskStopOptions): Promise<ManagedTaskStopResult> => this.#stopRecord(record, options),
      snapshot: (): ManagedTaskSnapshot => this.#taskSnapshot(record),
    });
  }

  stop(name: string, options?: ManagedTaskStopOptions): Promise<ManagedTaskStopResult> {
    const record = this.#tasks.get(name);
    if (!record) return Promise.resolve(Object.freeze({ name, status: "not_found" as const }));
    return this.#stopRecord(record, options);
  }

  close({ reason, timeoutMs = this.teardownTimeoutMs }: ManagedTaskStopOptions = {}): Promise<void> {
    if (this.#state === "closed") return Promise.resolve();
    if (this.#state === "closing") return this.#closePromise!;
    this.#state = "closing";
    const records = [...this.#tasks.values()];
    this.#closePromise = (async () => {
      const results = await Promise.allSettled(records.map((record) => this.#stopRecord(record, {
        reason: abortReason(reason, "managed task registry is closing"),
        timeoutMs,
      })));
      this.#state = "closed";
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(({ reason: error }) => error);
      if (errors.length) throw new AggregateError(errors, "managed task shutdown failed");
    })();
    return this.#closePromise;
  }

  snapshot(): Readonly<{ state: string; teardown_timeout_ms: number; tasks: readonly ManagedTaskSnapshot[] }> {
    return Object.freeze({
      state: this.#state,
      teardown_timeout_ms: this.teardownTimeoutMs,
      tasks: Object.freeze([...this.#tasks.values()].map((record) => this.#taskSnapshot(record))),
    });
  }

  async #stopRecord(record: ManagedTaskRecord, { reason, timeoutMs = this.teardownTimeoutMs }: ManagedTaskStopOptions = {}): Promise<ManagedTaskStopResult> {
    const resolvedTimeout = positiveInteger(timeoutMs, this.teardownTimeoutMs, "timeoutMs");
    if (!record.controller.signal.aborted) {
      record.status = "stopping";
      record.controller.abort(abortReason(reason));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        record.status = "timed_out";
        if (!record.terminationRequested && record.terminate) {
          record.terminationRequested = true;
          Promise.resolve().then(() => record.terminate?.()).catch(() => {});
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
      if (timer) clearTimeout(timer);
    }
    return Object.freeze({ name: record.name, status: "stopped" as const });
  }

  #taskSnapshot(record: ManagedTaskRecord): ManagedTaskSnapshot {
    return Object.freeze({
      name: record.name,
      status: record.status,
      started_at_ms: record.started_at_ms,
      settled_at_ms: record.settled_at_ms,
      supervised: typeof record.terminate === "function",
    });
  }
}

export function createManagedTaskRegistry(options?: ConstructorParameters<typeof ManagedTaskRegistry>[0]): ManagedTaskRegistry {
  return new ManagedTaskRegistry(options);
}
