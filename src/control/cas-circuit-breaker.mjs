function positiveInteger(value, fallback, name) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new TypeError(`${name} must be a positive integer`);
  return resolved;
}

function circuitOpen() {
  return Object.assign(new Error("control circuit is open"), {
    code: "UPSTREAM_UNAVAILABLE",
    breakerEligible: false,
    circuitOpen: true,
  });
}

/**
 * Versioned compare-and-swap state prevents stale concurrent completions from
 * closing a newer open circuit or admitting more than one half-open probe.
 */
export class CasCircuitBreaker {
  #state = Object.freeze({ phase: "closed", failures: 0, openUntil: 0, epoch: 0, version: 0 });

  constructor({ threshold = 3, cooldownMs = 30_000, now = () => Date.now() } = {}) {
    this.threshold = positiveInteger(threshold, 3, "threshold");
    this.cooldownMs = positiveInteger(cooldownMs, 30_000, "cooldownMs");
    this.now = now;
  }

  #compareAndSwap(expectedVersion, next) {
    if (this.#state.version !== expectedVersion) return false;
    this.#state = Object.freeze({ ...next, version: expectedVersion + 1 });
    return true;
  }

  #acquire() {
    for (;;) {
      const state = this.#state;
      if (state.phase === "closed") return Object.freeze({ phase: "closed", epoch: state.epoch });
      if (state.phase === "half-open") throw circuitOpen();
      if (this.now() < state.openUntil) throw circuitOpen();
      if (this.#compareAndSwap(state.version, {
        phase: "half-open",
        failures: state.failures,
        openUntil: state.openUntil,
        epoch: state.epoch,
      })) {
        return Object.freeze({ phase: "half-open", epoch: state.epoch, version: state.version + 1 });
      }
    }
  }

  #success(permit) {
    for (;;) {
      const state = this.#state;
      if (permit.phase === "half-open") {
        if (state.phase !== "half-open" || state.version !== permit.version) return;
        if (this.#compareAndSwap(state.version, {
          phase: "closed",
          failures: 0,
          openUntil: 0,
          epoch: state.epoch + 1,
        })) return;
        continue;
      } else if (state.phase !== "closed" || state.epoch !== permit.epoch) {
        return;
      }
      if (this.#compareAndSwap(state.version, {
        phase: "closed",
        failures: 0,
        openUntil: 0,
        epoch: state.epoch,
      })) return;
    }
  }

  #failure(permit) {
    for (;;) {
      const state = this.#state;
      if (permit.phase === "half-open") {
        if (state.phase !== "half-open" || state.version !== permit.version) return;
        if (this.#compareAndSwap(state.version, {
          phase: "open",
          failures: Math.max(state.failures, this.threshold),
          openUntil: this.now() + this.cooldownMs,
          epoch: state.epoch,
        })) return;
        continue;
      }
      if (state.phase !== "closed" || state.epoch !== permit.epoch) return;
      const failures = state.failures + 1;
      if (this.#compareAndSwap(state.version, failures >= this.threshold
        ? { phase: "open", failures, openUntil: this.now() + this.cooldownMs, epoch: state.epoch }
        : { phase: "closed", failures, openUntil: 0, epoch: state.epoch })) return;
    }
  }

  #neutral(permit) {
    for (;;) {
      const state = this.#state;
      if (permit.phase !== "half-open") return;
      if (state.phase !== "half-open" || state.version !== permit.version) return;
      if (this.#compareAndSwap(state.version, {
        phase: "open",
        failures: state.failures,
        openUntil: this.now() + this.cooldownMs,
        epoch: state.epoch,
      })) return;
    }
  }

  async run(operation) {
    if (typeof operation !== "function") throw new TypeError("circuit operation must be a function");
    const permit = this.#acquire();
    try {
      const result = await operation();
      this.#success(permit);
      return result;
    } catch (error) {
      if (error?.breakerEligible === false) this.#neutral(permit);
      else this.#failure(permit);
      throw error;
    }
  }

  snapshot() {
    const state = this.#state;
    return Object.freeze({
      state: state.phase === "open" && this.now() >= state.openUntil ? "half-open" : state.phase,
      failures: state.failures,
      version: state.version,
    });
  }
}
