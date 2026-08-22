export const DEFAULT_SOFT_TIMEOUT_MS = 10_000;
export const DEFAULT_HARD_GRACE_MS = 2_000;

type BreakerReason = Error & {
  breakerEligible?: boolean;
  code?: string;
};

export type StagedTimeoutPhase = "soft" | "hard";

export type StagedTimeoutOperation<T> = (
  signal: AbortSignal,
) => T | PromiseLike<T>;

export interface StagedTimeoutOptions {
  signal?: AbortSignal;
  softTimeoutMs?: number;
  hardGraceMs?: number;
  label?: string;
  onSoftTimeout?: (reason: BreakerReason) => void | PromiseLike<void>;
  onHardTimeout?: (reason: StagedTimeoutError) => void | PromiseLike<void>;
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

export class StagedTimeoutError extends Error {
  readonly code = "UPSTREAM_UNAVAILABLE";
  readonly phase: StagedTimeoutPhase;
  readonly elapsed_ms: number;
  breakerEligible = true;

  constructor(label: string, phase: StagedTimeoutPhase, elapsedMs: number) {
    super(`${label} exceeded its ${phase} timeout`);
    this.name = "StagedTimeoutError";
    this.phase = phase;
    this.elapsed_ms = elapsedMs;
  }
}

function parentAbortReason(signal: AbortSignal | undefined, label: string): BreakerReason {
  const source = signal?.reason;
  const reason = new Error(
    source instanceof Error ? source.message : `${label} was aborted`,
    source instanceof Error ? { cause: source } : undefined,
  ) as BreakerReason;
  reason.name = "AbortError";
  reason.code = source?.code ?? "UPSTREAM_UNAVAILABLE";
  reason.breakerEligible = false;
  return reason;
}

/**
 * Gives an operation a cooperative abort signal after the soft deadline. The
 * caller then waits for bounded cleanup before invoking the optional hard-stop
 * hook and rejecting. Only an isolated worker/process can be physically killed.
 */
export async function runWithStagedTimeout<T>(
  operation: StagedTimeoutOperation<T>,
  {
    signal: parentSignal,
    softTimeoutMs = DEFAULT_SOFT_TIMEOUT_MS,
    hardGraceMs = DEFAULT_HARD_GRACE_MS,
    label = "operation",
    onSoftTimeout,
    onHardTimeout,
  }: StagedTimeoutOptions = {},
): Promise<T> {
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  const softMs = positiveInteger(softTimeoutMs, DEFAULT_SOFT_TIMEOUT_MS, "softTimeoutMs");
  const graceMs = positiveInteger(hardGraceMs, DEFAULT_HARD_GRACE_MS, "hardGraceMs");
  const controller = new AbortController();
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectHard!: (reason: unknown) => void;
  let cancellationReason: BreakerReason | StagedTimeoutError | undefined;

  const hardFailure = new Promise<never>((_, reject) => {
    rejectHard = reject;
  });

  function cancel(
    reason: BreakerReason | StagedTimeoutError,
    { soft = false }: { soft?: boolean } = {},
  ): void {
    if (controller.signal.aborted) return;
    cancellationReason = reason;
    controller.abort(reason);
    if (soft) {
      Promise.resolve()
        .then(() => onSoftTimeout?.(reason))
        .catch(() => {});
    }
    hardTimer = setTimeout(() => {
      const hardError = new StagedTimeoutError(label, "hard", softMs + graceMs);
      if (cancellationReason?.breakerEligible === false) {
        hardError.breakerEligible = false;
        hardError.cause = cancellationReason;
      }
      Promise.resolve()
        .then(() => onHardTimeout?.(hardError))
        .catch(() => {});
      rejectHard(hardError);
    }, graceMs);
  }

  const onParentAbort = (): void => cancel(parentAbortReason(parentSignal, label));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const softTimer = setTimeout(() => {
    cancel(new StagedTimeoutError(label, "soft", softMs), { soft: true });
  }, softMs);

  const operationResult = Promise.resolve()
    .then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    })
    .then(
      (value) => {
        if (controller.signal.aborted) throw cancellationReason;
        return value;
      },
      (error: unknown) => {
        if (controller.signal.aborted) throw cancellationReason;
        throw error;
      },
    );

  try {
    return await Promise.race([operationResult, hardFailure]);
  } finally {
    clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
