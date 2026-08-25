export type RateLimitDecision = Readonly<{
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}>;

type RateLimitEntry = { count: number; resetAt: number };

function positiveInteger(
  value: unknown,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > maximum
  )
    throw new TypeError(`${name} must be between 1 and ${maximum}`);
  return resolved;
}

export function createRateLimiter({
  windowMs = 60_000,
  maxRequests = 120,
  maxKeys = 10_000,
  now = () => Date.now(),
}: {
  windowMs?: unknown;
  maxRequests?: unknown;
  maxKeys?: unknown;
  now?: () => number;
} = {}) {
  const window = positiveInteger(windowMs, 60_000, "windowMs", 3_600_000);
  const maximum = positiveInteger(
    maxRequests,
    120,
    "maxRequests",
    1_000_000,
  );
  const capacity = positiveInteger(maxKeys, 10_000, "maxKeys", 1_000_000);
  const entries = new Map<string, RateLimitEntry>();

  function prune(timestamp: number): void {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= timestamp) entries.delete(key);
    }
  }

  return Object.freeze({
    check(key: string): RateLimitDecision {
      const normalized = key.slice(0, 256) || "unknown";
      const timestamp = now();
      let entry = entries.get(normalized);
      if (!entry || entry.resetAt <= timestamp) {
        prune(timestamp);
        entry = entries.get(normalized);
        if (!entry && entries.size >= capacity)
          entry = entries.values().next().value as RateLimitEntry | undefined;
        if (!entry) {
          entry = { count: 0, resetAt: timestamp + window };
          entries.set(normalized, entry);
        }
      }
      entry.count += 1;
      const allowed = entry.count <= maximum;
      return Object.freeze({
        allowed,
        remaining: Math.max(0, maximum - entry.count),
        retry_after_seconds: Math.max(
          1,
          Math.ceil((entry.resetAt - timestamp) / 1000),
        ),
      });
    },
    get size() {
      return entries.size;
    },
  });
}
