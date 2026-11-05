import { test } from "node:test";
import assert from "node:assert/strict";
import {
  centsToInput,
  formatCents,
  formatWholeDollars,
  moneyProblem,
  parseCents,
} from "../src/billing/money";

test("typed digits become integer cents", () => {
  assert.deepEqual(parseCents("1234.56"), { ok: true, cents: 123456 });
  assert.deepEqual(parseCents("$5,000.00"), { ok: true, cents: 500000 });
  assert.deepEqual(parseCents("12"), { ok: true, cents: 1200 });
  assert.deepEqual(parseCents("0.5"), { ok: true, cents: 50 });
  assert.deepEqual(parseCents("7."), { ok: true, cents: 700 });
  // The classic float traps stay exact.
  assert.deepEqual(parseCents("0.07"), { ok: true, cents: 7 });
  assert.deepEqual(parseCents("1.15"), { ok: true, cents: 115 });
  assert.deepEqual(parseCents("19.99"), { ok: true, cents: 1999 });
});

test("more than two decimal places is refused, never rounded", () => {
  for (const text of ["1.005", "0.001", "12.345", "1.2345678"]) {
    const result = parseCents(text);
    assert.equal(result.ok, false, text);
    assert.equal(!result.ok && result.reason, "precision");
  }
  assert.match(moneyProblem(parseCents("1.005")), /at most two decimal places/);
});

test("anything that is not an amount is refused", () => {
  for (const text of ["abc", "-5", "1,2,3", "1.2.3", "1e3", "12,34", ",100", "1 000.00x"])
    assert.equal(parseCents(text).ok, false, text);
  assert.deepEqual(parseCents("   "), { ok: false, reason: "empty" });
  assert.equal(parseCents("12345678901").ok, false);
});

test("amounts are formatted from cents", () => {
  assert.equal(formatCents(650000), "$6,500.00");
  assert.equal(formatCents(5), "$0.05");
  assert.equal(formatCents(123456789), "$1,234,567.89");
  assert.equal(formatCents(-50000), "−$500.00");
  assert.equal(centsToInput(500000), "5000.00");
  assert.equal(formatWholeDollars(640000), "$6,400");
});
