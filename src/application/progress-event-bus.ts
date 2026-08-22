export type ProgressScalar = string | number | boolean | null;

export interface ProgressEvent {
  readonly type: string;
  readonly request_id: string;
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly occurred_at: string;
  readonly conversation_id?: string;
  readonly [field: string]: ProgressScalar | undefined;
}

export interface ProgressSubscription {
  readonly tenantId: string;
  readonly requestId?: string;
  readonly conversationId?: string;
  readonly signal?: AbortSignal;
  readonly capacity?: number;
}

type Waiter = {
  resolve: (value: IteratorResult<ProgressEvent>) => void;
  reject: (reason?: unknown) => void;
};

type Subscriber = {
  selector: ProgressSubscription;
  capacity: number;
  queue: ProgressEvent[];
  waiters: Waiter[];
  closed: boolean;
  terminalError?: unknown;
  errorDelivered: boolean;
  onAbort?: () => void;
};

export class ProgressBackpressureError extends Error {
  readonly code = "PROGRESS_BACKPRESSURE";
  readonly breakerEligible = false;

  constructor(capacity: number) {
    super(`progress subscriber exceeded its ${capacity}-event buffer`);
    this.name = "ProgressBackpressureError";
  }
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function matches(event: ProgressEvent, selector: ProgressSubscription): boolean {
  return event.tenant_id === selector.tenantId
    && (selector.requestId === undefined || event.request_id === selector.requestId)
    && (selector.conversationId === undefined || event.conversation_id === selector.conversationId);
}

function freezeEvent(event: ProgressEvent): ProgressEvent {
  requiredString(event.type, "progress event type");
  requiredString(event.request_id, "progress request_id");
  requiredString(event.tenant_id, "progress tenant_id");
  requiredString(event.actor_id, "progress actor_id");
  requiredString(event.occurred_at, "progress occurred_at");
  for (const [field, value] of Object.entries(event)) {
    if (value !== undefined && value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new TypeError(`progress field ${field} must be a JSON scalar`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`progress field ${field} must be finite`);
    }
  }
  return Object.freeze({ ...event });
}

/**
 * A bounded in-process SPMC projection bus. Application services publish once;
 * transport adapters subscribe with an authenticated tenant selector. Durable
 * delivery remains the responsibility of the database outbox.
 */
export class ProgressEventBus {
  #subscribers = new Set<Subscriber>();
  #closed = false;

  readonly defaultCapacity: number;

  constructor({ defaultCapacity = 64 }: { defaultCapacity?: number } = {}) {
    this.defaultCapacity = positiveInteger(defaultCapacity, 64, "defaultCapacity");
  }

  get closed(): boolean { return this.#closed; }

  emit(event: ProgressEvent): number {
    if (this.#closed) return 0;
    const immutable = freezeEvent(event);
    let delivered = 0;
    for (const subscriber of this.#subscribers) {
      if (subscriber.closed || !matches(immutable, subscriber.selector)) continue;
      const waiter = subscriber.waiters.shift();
      if (waiter) {
        waiter.resolve({ done: false, value: immutable });
        delivered += 1;
        continue;
      }
      if (subscriber.queue.length >= subscriber.capacity) {
        this.#closeSubscriber(subscriber, new ProgressBackpressureError(subscriber.capacity));
        continue;
      }
      subscriber.queue.push(immutable);
      delivered += 1;
    }
    return delivered;
  }

  subscribe({
    tenantId,
    requestId,
    conversationId,
    signal,
    capacity = this.defaultCapacity,
  }: ProgressSubscription): AsyncIterableIterator<ProgressEvent> {
    if (this.#closed) throw new Error("progress event bus is closed");
    requiredString(tenantId, "tenantId");
    if (requestId !== undefined) requiredString(requestId, "requestId");
    if (conversationId !== undefined) requiredString(conversationId, "conversationId");
    const subscriber: Subscriber = {
      selector: Object.freeze({ tenantId, requestId, conversationId, signal }),
      capacity: positiveInteger(capacity, this.defaultCapacity, "capacity"),
      queue: [],
      waiters: [],
      closed: false,
      errorDelivered: false,
    };
    subscriber.onAbort = () => this.#closeSubscriber(
      subscriber,
      signal?.reason ?? Object.assign(new Error("progress subscription was aborted"), { name: "AbortError" }),
    );
    if (signal?.aborted) subscriber.onAbort();
    else signal?.addEventListener("abort", subscriber.onAbort, { once: true });
    if (!subscriber.closed) this.#subscribers.add(subscriber);

    const iterator: AsyncIterableIterator<ProgressEvent> = {
      [Symbol.asyncIterator](): AsyncIterableIterator<ProgressEvent> { return iterator; },
      next: (): Promise<IteratorResult<ProgressEvent>> => {
        const queued = subscriber.queue.shift();
        if (queued) return Promise.resolve({ done: false, value: queued });
        if (subscriber.closed) {
          if (subscriber.terminalError !== undefined && !subscriber.errorDelivered) {
            subscriber.errorDelivered = true;
            return Promise.reject(subscriber.terminalError);
          }
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => subscriber.waiters.push({ resolve, reject }));
      },
      return: async (): Promise<IteratorResult<ProgressEvent>> => {
        this.#closeSubscriber(subscriber);
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown): Promise<IteratorResult<ProgressEvent>> => {
        this.#closeSubscriber(subscriber, error);
        throw error;
      },
    };
    return iterator;
  }

  close(reason?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      this.#closeSubscriber(subscriber, reason);
    }
  }

  #closeSubscriber(subscriber: Subscriber, error?: unknown): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.terminalError = error;
    subscriber.queue.length = 0;
    this.#subscribers.delete(subscriber);
    subscriber.selector.signal?.removeEventListener("abort", subscriber.onAbort!);
    const waiters = subscriber.waiters.splice(0);
    if (error !== undefined && waiters.length > 0) subscriber.errorDelivered = true;
    for (const waiter of waiters) {
      if (error === undefined) waiter.resolve({ done: true, value: undefined });
      else waiter.reject(error);
    }
  }
}

export function createProgressEventBus(options?: ConstructorParameters<typeof ProgressEventBus>[0]): ProgressEventBus {
  return new ProgressEventBus(options);
}
