import { createExtensionRegistry } from "../extensions/index.mjs";
import { runWithStagedTimeout } from "../lifecycle/staged-timeout.mjs";
import { CasCircuitBreaker } from "./cas-circuit-breaker.mjs";

export class ControlEngine {
  #breakers = new Map();
  #startPromise;
  #closePromise;

  constructor({ extensions = createExtensionRegistry(), now = () => Date.now() } = {}) {
    this.extensions = extensions;
    this.now = now;
  }

  breaker(key, options = {}) {
    if (typeof key !== "string" || !key) throw new TypeError("circuit key is required");
    if (!this.#breakers.has(key)) this.#breakers.set(key, new CasCircuitBreaker({ ...options, now: this.now }));
    return this.#breakers.get(key);
  }

  async run(key, operation, {
    signal,
    softTimeoutMs,
    hardGraceMs,
    label = key,
    breaker: breakerOptions,
    onSoftTimeout,
    onHardTimeout,
  } = {}) {
    return await this.breaker(key, breakerOptions).run(() => runWithStagedTimeout(operation, {
      signal,
      softTimeoutMs,
      hardGraceMs,
      label,
      onSoftTimeout,
      onHardTimeout,
    }));
  }

  start(context = {}) {
    this.#startPromise ??= this.extensions.startAll(context);
    return this.#startPromise;
  }

  close(options) {
    this.#closePromise ??= this.extensions.stopAll(options);
    return this.#closePromise;
  }

  snapshot() {
    return Object.freeze(Object.fromEntries(
      [...this.#breakers.entries()].map(([key, breaker]) => [key, breaker.snapshot()]),
    ));
  }
}

export function createControlEngine(options) {
  return new ControlEngine(options);
}
