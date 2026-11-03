import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReset } from "../src/shared/quota";

// The reset is one fixed instant for everyone: Saturday 12:00 New York time. Each viewer sees it in their own zone.
const withZone = (zone: string, run: () => void) => {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
};

test("the reset time is shown in the viewer's own time zone, and the zone is named", () => {
  withZone("America/New_York", () => {
    assert.match(formatReset("2030-03-23T16:00:00.000Z"), /Sat, Mar 23, 12:00 PM EDT/);
    assert.match(formatReset("2030-01-12T17:00:00.000Z"), /Sat, Jan 12, 12:00 PM EST/);
  });
  withZone("America/Los_Angeles", () =>
    assert.match(formatReset("2030-03-23T16:00:00.000Z"), /Sat, Mar 23, 9:00 AM PDT/),
  );
  withZone("Asia/Tokyo", () =>
    assert.match(formatReset("2030-03-23T16:00:00.000Z"), /Sun, Mar 24, 1:00 AM GMT\+9/),
  );
});

test("a malformed time reads as soon rather than a wrong time", () => {
  assert.equal(formatReset("not a time"), "soon");
});
