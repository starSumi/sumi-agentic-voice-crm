type CancellationReason = Error & { retryEligible?: boolean };

export type TaskLifecycleOptions = {
  signal?: AbortSignal;
  softTimeoutMs: number;
  hardGraceMs: number;
  label: string;
  onSoftTimeout?: (reason: Error) => void | PromiseLike<void>;
  onHardTimeout?: (
    reason: TaskLifecycleTimeoutError,
  ) => void | PromiseLike<void>;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function cancellationReason(
  signal: AbortSignal | undefined,
  label: string,
): CancellationReason {
  const source = signal?.reason;
  const reason = new Error(
    source instanceof Error ? source.message : `${label} was cancelled`,
    source instanceof Error ? { cause: source } : undefined,
  ) as CancellationReason;
  reason.name = "AbortError";
  reason.retryEligible = false;
  return reason;
}

export class TaskLifecycleTimeoutError extends Error {
  readonly code = "TASK_LIFECYCLE_TIMEOUT";
  readonly phase: "soft" | "hard";
  readonly retryEligible: boolean;
  constructor(label: string, phase: "soft" | "hard", retryEligible = true) {
    super(`${label} exceeded its ${phase} timeout`);
    this.name = "TaskLifecycleTimeoutError";
    this.phase = phase;
    this.retryEligible = retryEligible;
  }
}

export async function runTaskLifecycle<T>(
  operation: (signal: AbortSignal) => T | PromiseLike<T>,
  options: TaskLifecycleOptions,
): Promise<T> {
  if (typeof operation !== "function")
    throw new TypeError("operation must be a function");
  const softMs = positiveInteger(options.softTimeoutMs, "softTimeoutMs");
  const hardMs = positiveInteger(options.hardGraceMs, "hardGraceMs");
  const controller = new AbortController();
  let cancellation: CancellationReason | TaskLifecycleTimeoutError | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectHard!: (reason: unknown) => void;
  const hardFailure = new Promise<never>((_, reject) => {
    rejectHard = reject;
  });

  const cancel = (
    reason: CancellationReason | TaskLifecycleTimeoutError,
    soft: boolean,
  ): void => {
    if (controller.signal.aborted) return;
    cancellation = reason;
    controller.abort(reason);
    if (soft)
      Promise.resolve()
        .then(() => options.onSoftTimeout?.(reason))
        .catch(() => {});
    hardTimer = setTimeout(() => {
      const hardError = new TaskLifecycleTimeoutError(
        options.label,
        "hard",
        reason.retryEligible !== false,
      );
      if (reason.retryEligible === false) hardError.cause = reason;
      Promise.resolve()
        .then(() => options.onHardTimeout?.(hardError))
        .catch(() => {});
      rejectHard(hardError);
    }, hardMs);
  };
  const onParentAbort = (): void =>
    cancel(cancellationReason(options.signal, options.label), false);
  if (options.signal?.aborted) onParentAbort();
  else options.signal?.addEventListener("abort", onParentAbort, { once: true });
  const softTimer = setTimeout(
    () => cancel(new TaskLifecycleTimeoutError(options.label, "soft"), true),
    softMs,
  );
  const result = Promise.resolve()
    .then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    })
    .then(
      (value) => {
        if (controller.signal.aborted) throw cancellation;
        return value;
      },
      (error: unknown) => {
        if (controller.signal.aborted) throw cancellation;
        throw error;
      },
    );
  try {
    return await Promise.race([result, hardFailure]);
  } finally {
    clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}
