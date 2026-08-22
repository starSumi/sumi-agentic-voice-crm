/**
 * Transport selection belongs to the API layer. Protocol types remain free of
 * client capability and network I/O concerns.
 */
export type TransportKind = "webtransport" | "websocket" | "sse" | "grpc" | "http";
export type TransportClientScope = "browser" | "desktop" | "tui" | "service";

export interface TransportCapabilities {
  readonly webtransport?: boolean;
  readonly websocket?: boolean;
  readonly sse?: boolean;
  readonly grpc?: boolean;
}

export interface TransportAdapter<TRequest, TResult> {
  readonly kind: TransportKind;
  readonly available?: () => boolean | Promise<boolean>;
  send(request: TRequest, signal?: AbortSignal): Promise<TResult>;
}

export interface TransportSelectionOptions {
  readonly preferred?: readonly TransportKind[];
  readonly capabilities?: TransportCapabilities;
  readonly clientScope?: TransportClientScope;
  readonly allowGrpc?: boolean;
}

export const TRANSPORT_PREFERENCES = Object.freeze({
  browser: Object.freeze(["webtransport", "websocket", "sse", "http"] as const),
  desktop: Object.freeze(["webtransport", "websocket", "sse", "http"] as const),
  tui: Object.freeze(["websocket", "sse", "http"] as const),
  service: Object.freeze(["grpc", "http"] as const),
}) satisfies Readonly<Record<TransportClientScope, readonly TransportKind[]>>;

const CLIENT_CAPABILITY_KEY: Readonly<Record<TransportKind, keyof TransportCapabilities | undefined>> = Object.freeze({
  webtransport: "webtransport",
  websocket: "websocket",
  sse: "sse",
  grpc: "grpc",
  http: undefined,
});

/**
 * Selects the first transport that the caller can use. HTTP is always the
 * final fallback. gRPC is opt-in because it is intended for trusted service
 * clients, not browser code.
 */
export function selectTransport({
  preferred,
  capabilities = {},
  clientScope = "browser",
  allowGrpc = false,
}: TransportSelectionOptions = {}): TransportKind {
  const ordered = preferred ?? TRANSPORT_PREFERENCES[clientScope];
  for (const kind of ordered) {
    if (kind === "grpc" && (!allowGrpc || clientScope !== "service")) continue;
    const capability = CLIENT_CAPABILITY_KEY[kind];
    if (capability === undefined || capabilities[capability] === true) return kind;
  }
  return "http";
}

/**
 * Sends through the first available adapter and only falls back for transport
 * availability/connection failures. An application response error is returned
 * to the caller and must not silently retry through another transport.
 */
export async function sendWithFallback<TRequest, TResult>(
  request: TRequest,
  adapters: readonly TransportAdapter<TRequest, TResult>[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<TResult> {
  if (adapters.length === 0) throw new Error("at least one transport adapter is required");
  let lastError: unknown;
  for (const adapter of adapters) {
    signal?.throwIfAborted();
    if (adapter.available && !(await adapter.available())) continue;
    try {
      return await adapter.send(request, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!isTransportAvailabilityError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("no transport adapter is available");
}

function isTransportAvailabilityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [
    "TRANSPORT_UNAVAILABLE",
    "TRANSPORT_CONNECT_FAILED",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
  ].includes((error as Error & { code?: string }).code ?? error.name);
}
