import { createExtensionRegistry } from "../extensions/index.ts";
import { createManagedTaskRegistry } from "../lifecycle/managed-task-registry.ts";
import { runWithStagedTimeout } from "../lifecycle/staged-timeout.ts";
import { CasCircuitBreaker } from "./cas-circuit-breaker.ts";

type ExtensionPort = {
  startAll(context?: unknown): PromiseLike<void>;
  close(options?: unknown): PromiseLike<void>;
};
type TaskPort = {
  start<T>(name: string, operation: (signal: AbortSignal) => T | PromiseLike<T>): { result: Promise<T> };
  close(options?: unknown): PromiseLike<void>;
  snapshot(): Readonly<Record<string, unknown>>;
};
type ControlEngineOptions = {
  extensions?: ExtensionPort;
  tasks?: TaskPort;
  teardownTimeoutMs?: number;
  now?: () => number;
};
type RunOptions = {
  signal?: AbortSignal;
  softTimeoutMs?: number;
  hardGraceMs?: number;
  label?: string;
  breaker?: ConstructorParameters<typeof CasCircuitBreaker>[0];
  onSoftTimeout?: () => void | PromiseLike<void>;
  onHardTimeout?: () => void | PromiseLike<void>;
};

export class ControlEngine {
  #breakers = new Map<string, CasCircuitBreaker>();
  #startPromise?: Promise<void>;
  #closePromise?: Promise<void>;
  readonly extensions: ExtensionPort;
  readonly tasks: TaskPort;
  readonly now: () => number;

  constructor({ extensions = createExtensionRegistry() as ExtensionPort, tasks, teardownTimeoutMs, now = () => Date.now() }: ControlEngineOptions = {}) {
    this.extensions = extensions;
    this.tasks = tasks ?? createManagedTaskRegistry({ teardownTimeoutMs, now });
    this.now = now;
  }

  breaker(key: string, options: ConstructorParameters<typeof CasCircuitBreaker>[0] = {}): CasCircuitBreaker {
    if (typeof key !== "string" || !key) throw new TypeError("circuit key is required");
    if (!this.#breakers.has(key)) this.#breakers.set(key, new CasCircuitBreaker({ ...options, now: this.now }));
    return this.#breakers.get(key)!;
  }

  async run<T>(key: string, operation: (signal: AbortSignal) => T | PromiseLike<T>, {
    signal,
    softTimeoutMs,
    hardGraceMs,
    label = key,
    breaker: breakerOptions,
    onSoftTimeout,
    onHardTimeout,
  }: RunOptions = {}): Promise<T> {
    return await this.breaker(key, breakerOptions).run(() => runWithStagedTimeout(operation, {
      signal,
      softTimeoutMs,
      hardGraceMs,
      label,
      onSoftTimeout,
      onHardTimeout,
    }));
  }

  start(context: unknown = {}): Promise<void> {
    this.#startPromise ??= Promise.resolve(this.extensions.startAll(context));
    return this.#startPromise;
  }

  close(options?: unknown): Promise<void> {
    this.#closePromise ??= (async () => {
      const errors: unknown[] = [];
      for (const resource of [this.tasks, this.extensions]) {
        try { await resource.close(options); } catch (error: unknown) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "control engine shutdown failed");
    })();
    return this.#closePromise;
  }

  taskSnapshot(): Readonly<Record<string, unknown>> {
    return this.tasks.snapshot();
  }

  snapshot(): Readonly<Record<string, ReturnType<CasCircuitBreaker["snapshot"]>>> {
    return Object.freeze(Object.fromEntries(
      [...this.#breakers.entries()].map(([key, breaker]) => [key, breaker.snapshot()]),
    ));
  }
}

export function createControlEngine(options?: ControlEngineOptions): ControlEngine {
  return new ControlEngine(options);
}
