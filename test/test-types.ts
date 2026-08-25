export type TestError = Error & {
  readonly breakerEligible?: boolean;
  readonly cause?: unknown;
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly phase?: string;
  readonly state?: unknown;
};

export function testError(value: unknown): TestError {
  if (!(value instanceof Error)) {
    throw new TypeError("expected an Error");
  }
  return value;
}

export function testRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return Object.fromEntries(Object.entries(value));
}

export function testErrorCause(value: unknown): Error | undefined {
  const cause = testError(value).cause;
  return cause instanceof Error ? cause : undefined;
}

export function testErrorDetails(value: unknown): Readonly<
  Record<string, unknown> & {
    max_bytes?: number;
    reason_codes: readonly string[];
  }
> {
  const details = testError(value).details;
  if (!details) {
    throw new TypeError("expected error details");
  }
  const reasonCodes = Array.isArray(details.reason_codes)
    ? details.reason_codes.filter(
        (reasonCode): reasonCode is string => typeof reasonCode === "string",
      )
    : [];
  const maxBytes =
    typeof details.max_bytes === "number" ? details.max_bytes : undefined;
  return Object.freeze({
    ...details,
    reason_codes: reasonCodes,
    ...(maxBytes === undefined ? {} : { max_bytes: maxBytes }),
  });
}
