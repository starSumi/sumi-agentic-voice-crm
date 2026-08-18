const textEncoder = new TextEncoder();

export const SSE_HEADERS = Object.freeze({
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
});

type SseEvent = Record<string, unknown>;
type SseRequest = { signal?: AbortSignal };
type SseEvents = {
  [Symbol.asyncIterator]?: () => AsyncIterator<SseEvent>;
  [Symbol.iterator]?: () => Iterator<SseEvent>;
};
type SseIterator = AsyncIterator<SseEvent>;

function asBytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function encodeSseEvent(event: SseEvent): Uint8Array {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("SSE event must be an object");
  const data = JSON.stringify(event);
  if (typeof data !== "string") throw new TypeError("SSE event must be JSON serializable");
  return asBytes("data: " + data + "\n\n");
}

export function encodeSseComment(comment = "keep-alive"): Uint8Array {
  const safe = String(comment).replace(/[\r\n]/g, " ");
  return asBytes(":" + safe + "\n\n");
}

function iteratorFor(events: SseEvents): SseIterator {
  const asyncFactory = events?.[Symbol.asyncIterator];
  if (typeof asyncFactory === "function") return asyncFactory.call(events);
  const syncFactory = events?.[Symbol.iterator];
  if (typeof syncFactory === "function") {
    const iterator = syncFactory.call(events);
    return {
      next: async () => iterator.next(),
      return: async () => ({ done: true, value: undefined }),
    };
  }
  throw new TypeError("SSE events must be iterable");
}

/**
 * Prepare a standards-compatible SSE response without adding an AG-UI runtime.
 * The async iterable is the future application/event adapter boundary. AG-UI
 * events already use the same data-only JSON frame, while Sumi CloudEvents can
 * be projected through the same transport without changing durable business truth.
 */
export function createSseResponse({ request, events, eventGuard = (event: SseEvent) => event, keepAliveMs = 0 }: { request?: SseRequest; events: SseEvents; eventGuard?: (event: SseEvent) => SseEvent; keepAliveMs?: number } ) {
  const iterator = iteratorFor(events);
  const signal = request?.signal;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
    if (typeof iterator.return === "function") void iterator.return();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stop();
    try { controller?.close(); } catch {}
  };
  const abort = () => close();

  const stream = new ReadableStream({
    start(nextController) {
      controller = nextController;
      if (signal?.aborted) return close();
      signal?.addEventListener("abort", abort, { once: true });
      if (Number.isSafeInteger(keepAliveMs) && keepAliveMs > 0) {
        keepAliveTimer = setInterval(() => {
          if (!closed && controller?.desiredSize !== null && controller?.desiredSize !== undefined && controller.desiredSize > 0) controller.enqueue(encodeSseComment());
        }, keepAliveMs);
      }
    },
    async pull(nextController) {
      if (closed) return;
      try {
        const next = await iterator.next();
        if (closed) return;
        if (next.done) return close();
        nextController.enqueue(encodeSseEvent(eventGuard(next.value)));
      } catch (error) {
        if (closed) return;
        closed = true;
        stop();
        nextController.error(error);
      }
    },
    async cancel(reason) {
      closed = true;
      stop();
      if (typeof iterator.return === "function") await iterator.return(reason);
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
