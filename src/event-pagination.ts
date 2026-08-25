const EVENT_ID = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const MAX_EVENT_PAGE_SIZE = 100;

export type EventCursor = Readonly<{ time: string; id: string }>;
export type EventPageInput = Readonly<{ limit?: unknown; cursor?: unknown }>;
export type EventPage = Readonly<{
  events: unknown[];
  next_cursor?: string;
}>;

export function eventPageLimit(value: unknown): number {
  const limit = value === undefined ? MAX_EVENT_PAGE_SIZE : Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_EVENT_PAGE_SIZE)
    throw Object.assign(
      new Error(`limit must be between 1 and ${MAX_EVENT_PAGE_SIZE}`),
      { code: "INVALID_REQUEST" },
    );
  return limit;
}

export function encodeEventCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify([cursor.time, cursor.id])).toString(
    "base64url",
  );
}

export function decodeEventCursor(value: unknown): EventCursor | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 512)
    throw Object.assign(new Error("event cursor is invalid"), {
      code: "INVALID_REQUEST",
    });
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!Array.isArray(decoded) || decoded.length !== 2)
      throw new Error("invalid cursor tuple");
    const [time, id] = decoded;
    if (
      typeof time !== "string" ||
      new Date(time).toISOString() !== time ||
      typeof id !== "string" ||
      !EVENT_ID.test(id) ||
      encodeEventCursor({ time, id }) !== value
    )
      throw new Error("invalid cursor values");
    return Object.freeze({ time, id });
  } catch (cause) {
    throw Object.assign(new Error("event cursor is invalid", { cause }), {
      code: "INVALID_REQUEST",
    });
  }
}

function eventCursor(value: unknown): EventCursor {
  const event =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  if (
    typeof event.time !== "string" ||
    typeof event.id !== "string" ||
    !EVENT_ID.test(event.id)
  )
    throw new TypeError("event page contains an invalid event envelope");
  return { time: event.time, id: event.id };
}

export function paginateEvents(
  values: readonly unknown[],
  input: EventPageInput = {},
): EventPage {
  const limit = eventPageLimit(input.limit);
  const cursor = decodeEventCursor(input.cursor);
  const ordered = [...values].sort((left, right) => {
    const a = eventCursor(left);
    const b = eventCursor(right);
    return a.time.localeCompare(b.time) || a.id.localeCompare(b.id);
  });
  const after = cursor
    ? ordered.filter((value) => {
        const current = eventCursor(value);
        return (
          current.time > cursor.time ||
          (current.time === cursor.time && current.id > cursor.id)
        );
      })
    : ordered;
  const events = after.slice(0, limit);
  return {
    events,
    ...(after.length > limit && events.length > 0
      ? { next_cursor: encodeEventCursor(eventCursor(events.at(-1))) }
      : {}),
  };
}
