/**
 * Money in billing is an integer number of US cents. Nothing here, or anywhere in billing, uses floating point:
 * amounts are read from digit strings, multiplied and added as safe integers, and printed by integer division.
 */
import { fail } from "./model";

/** $100,000,000.00. Far above any invoice, and small enough that sums and products stay exact integers. */
export const MAXIMUM_CENTS = 10_000_000_000;
export const MAXIMUM_QUANTITY = 1_000_000;

export const isCents = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAXIMUM_CENTS;

/** A whole, positive number of cents, or a 400 naming the field. Never rounds. */
export function requirePositiveCents(value: unknown, label: string): number {
  if (!isCents(value) || value === 0)
    fail(400, "invalid_amount", `${label} must be a positive whole number of cents.`);
  return value;
}

export function lineTotalCents(quantity: number, unitAmountCents: number): number {
  const total = quantity * unitAmountCents;
  if (!Number.isSafeInteger(total) || total > MAXIMUM_CENTS)
    fail(400, "invalid_amount", "A line total is too large.");
  return total;
}

export function sumCents(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) fail(400, "invalid_amount", "A total is too large.");
  }
  return total;
}

/**
 * Reads "1234.56", "$1,234.56" or "1234" as cents, for the CLI and any other caller that takes dollars. More than
 * two decimal places, a sign or an exponent is refused, never rounded.
 */
export function parseDollars(text: string): number | null {
  const clean = text.replace(/[$\s]/g, "");
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{0,2}))?$/.exec(clean);
  if (!match) return null;
  const cents = Number(match[1].replace(/,/g, "")) * 100 + Number(`${match[2] ?? ""}00`.slice(0, 2));
  return isCents(cents) ? cents : null;
}

/** "$6,500.00" from integer cents, by splitting the digits: no division and no floating point. */
export function formatUsd(cents: number): string {
  const digits = String(cents < 0 ? -cents : cents).padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}$${whole}.${digits.slice(-2)}`;
}
