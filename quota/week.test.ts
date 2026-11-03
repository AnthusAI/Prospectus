import { test } from "node:test";
import assert from "node:assert/strict";
import { HOUR_MS, QUOTA_WEEK_ZONE, SHORTEST_WEEK_MS, previousWeekKey, weekAt } from "./week";

const iso = (text: string) => Date.parse(text);
const hours = (week: { startMs: number; endMs: number }) => (week.endMs - week.startMs) / HOUR_MS;

test("the zone is America/New_York and is named in one place", () => {
  assert.equal(QUOTA_WEEK_ZONE, "America/New_York");
});

test("a week starts on Saturday at noon New York time and is keyed by that date", () => {
  // Saturday 2030-01-05 12:00 EST is 17:00 UTC; the week lasts to Saturday 2030-01-12 17:00 UTC.
  const week = weekAt(iso("2030-01-09T03:00:00.000Z"));
  assert.equal(week.key, 20300105);
  assert.equal(week.startsAt, "2030-01-05T17:00:00.000Z");
  assert.equal(week.endsAt, "2030-01-12T17:00:00.000Z");
  assert.equal(hours(week), 168);
});

test("the exact boundary instant belongs to the week it starts, and the instant before to the week it ends", () => {
  const boundary = iso("2030-01-12T17:00:00.000Z");
  assert.equal(weekAt(boundary).key, 20300112);
  assert.equal(weekAt(boundary).startMs, boundary);
  assert.equal(weekAt(boundary - 1).key, 20300105);
  assert.equal(weekAt(boundary - 1).endMs, boundary);
  assert.equal(previousWeekKey(boundary), 20300105);
});

test("every Account shares the same boundary, whenever it was created", () => {
  const a = weekAt(iso("2030-01-07T00:00:00.000Z")),
    b = weekAt(iso("2030-01-11T23:59:59.000Z"));
  assert.deepEqual([a.key, a.startsAt, a.endsAt], [b.key, b.startsAt, b.endsAt]);
});

test("Saturday before noon is still last week and Saturday after noon is the new week", () => {
  assert.equal(weekAt(iso("2030-01-12T16:59:59.999Z")).key, 20300105);
  assert.equal(weekAt(iso("2030-01-12T17:00:00.000Z")).key, 20300112);
  assert.equal(weekAt(iso("2030-01-13T04:00:00.000Z")).key, 20300112, "Sunday is in the Saturday week");
  assert.equal(weekAt(iso("2030-01-18T16:59:59.000Z")).key, 20300112, "Friday evening too");
});

test("the week that contains the spring clock change is 167 hours", () => {
  // Clocks spring forward on Sunday 2030-03-10. Saturday 03-09 12:00 is EST (17:00 UTC); Saturday 03-16 12:00 is EDT (16:00 UTC).
  const week = weekAt(iso("2030-03-12T12:00:00.000Z"));
  assert.equal(week.key, 20300309);
  assert.equal(week.startsAt, "2030-03-09T17:00:00.000Z");
  assert.equal(week.endsAt, "2030-03-16T16:00:00.000Z");
  assert.equal(hours(week), 167);
  assert.equal(week.endMs - week.startMs, SHORTEST_WEEK_MS);
  assert.equal(weekAt(week.endMs).key, 20300316);
  assert.equal(weekAt(week.endMs - 1).key, 20300309);
});

test("the week that contains the autumn clock change is 169 hours", () => {
  // Clocks fall back on Sunday 2030-11-03. Saturday 11-02 12:00 is EDT (16:00 UTC); Saturday 11-09 12:00 is EST (17:00 UTC).
  const week = weekAt(iso("2030-11-05T12:00:00.000Z"));
  assert.equal(week.key, 20301102);
  assert.equal(week.startsAt, "2030-11-02T16:00:00.000Z");
  assert.equal(week.endsAt, "2030-11-09T17:00:00.000Z");
  assert.equal(hours(week), 169);
  assert.equal(weekAt(week.endMs).key, 20301109);
  assert.equal(weekAt(week.endMs - 1).key, 20301102);
});

test("the instants inside the clock-change hour never move a boundary", () => {
  // Sunday 2030-11-03 05:30 UTC is 01:30 EDT, and 06:30 UTC is 01:30 EST: the same wall time twice.
  for (const text of [
    "2030-11-03T05:30:00.000Z",
    "2030-11-03T06:30:00.000Z",
    "2030-03-10T06:59:00.000Z",
    "2030-03-10T07:00:00.000Z",
  ]) {
    const week = weekAt(iso(text));
    assert.ok(week.startMs <= iso(text) && iso(text) < week.endMs, text);
  }
});

test("weeks tile time with no gap or overlap across a whole year including both changes", () => {
  let cursor = weekAt(iso("2030-01-01T00:00:00.000Z"));
  const lengths = new Set<number>();
  for (let index = 0; index < 60; index++) {
    const next = weekAt(cursor.endMs);
    assert.equal(next.startMs, cursor.endMs);
    assert.ok(next.key > cursor.key);
    lengths.add(hours(cursor));
    cursor = next;
  }
  assert.deepEqual([...lengths].sort(), [167, 168, 169]);
});

test("the previous week key is that of the week before, even across a clock change", () => {
  assert.equal(previousWeekKey(iso("2030-03-17T12:00:00.000Z")), 20300309);
  assert.equal(previousWeekKey(iso("2030-11-10T12:00:00.000Z")), 20301102);
});
