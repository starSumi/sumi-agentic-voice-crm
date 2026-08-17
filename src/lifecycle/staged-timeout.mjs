export const DEFAULT_SOFT_TIMEOUT_MS = 10_000;
export const DEFAULT_HARD_GRACE_MS = 2_000;

function positiveInteger(value, fallback, name) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

export class StagedTimeoutError extends Error {
  constructor(label, phase, elapsedMs) {
    super(`${label} exceeded its ${phase} timeout`);
    this.name = "StagedTimeoutError";
    this.code = "UPSTREAM_UNAVAILABLE";
    this.phase = phase;
    this.elapsed_ms = elapsedMs;
    this.breakerEligible = true;
  }
}

function parentAbortReason(signal, label) {
  const source = signal?.reason;
  return Object.assign(new Error(
    source instanceof Error ? source.message : `${label} was aborted`,
    source instanceof Error ? { cause: source } : undefined,
  ), {
    name: "AbortError",
    code: source?.code ?? "UPSTREAM_UNAVAILABLE",
    breakerEligible: false,
  });
}

/**
 * Gives an operation a cooperative abort signal after the soft deadline. The
 * caller then waits for bounded cleanup before invoking the optional hard-stop
 * hook and rejecting. Only an isolated worker/process can be physically killed.
 */
export async function runWithStagedTimeout(operation, {
  signal: parentSignal,
  softTimeoutMs = DEFAULT_SOFT_TIMEOUT_MS,
  hardGraceMs = DEFAULT_HARD_GRACE_MS,
  label = "operation",
  onSoftTimeout,
  onHardTimeout,
} = {}) {
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  const softMs = positiveInteger(softTimeoutMs, DEFAULT_SOFT_TIMEOUT_MS, "softTimeoutMs");
  const graceMs = positiveInteger(hardGraceMs, DEFAULT_HARD_GRACE_MS, "hardGraceMs");
  const controller = new AbortController();
  let hardTimer;
  let rejectHard;
  let cancellationReason;

  const hardFailure = new Promise((_, reject) => { rejectHard = reject; });
  function cancel(reason, { soft = false } = {}) {
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

  const onParentAbort = () => cancel(parentAbortReason(parentSignal, label));
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
    .then((value) => {
      if (controller.signal.aborted) throw cancellationReason;
      return value;
    }, (error) => {
      if (controller.signal.aborted) throw cancellationReason;
      throw error;
    });

  try {
    return await Promise.race([operationResult, hardFailure]);
  } finally {
    clearTimeout(softTimer);
    clearTimeout(hardTimer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
