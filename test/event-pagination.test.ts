import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeEventCursor,
  paginateEvents,
} from "../src/event-pagination.ts";

function event(index: number) {
  return {
    id: `evt_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    time: new Date(index * 1000).toISOString(),
  };
}

test("event pages use a stable time and id keyset without gaps", () => {
  const input = [event(3), event(1), event(2)];
  const first = paginateEvents(input, { limit: 2 });
  assert.deepEqual(first.events, [event(1), event(2)]);
  assert.ok(first.next_cursor);
  const second = paginateEvents(input, {
    limit: 2,
    cursor: first.next_cursor,
  });
  assert.deepEqual(second, { events: [event(3)] });
});

test("event cursors reject malformed and non-canonical input", () => {
  assert.throws(
    () => decodeEventCursor("not-a-cursor"),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "INVALID_REQUEST",
  );
  const padded = Buffer.from(
    JSON.stringify([event(1).time, event(1).id]),
  ).toString("base64");
  assert.throws(() => decodeEventCursor(padded), /cursor is invalid/);
});

test("event page limits are bounded", () => {
  assert.throws(() => paginateEvents([], { limit: 0 }), /between 1 and 100/);
  assert.throws(() => paginateEvents([], { limit: 101 }), /between 1 and 100/);
});
