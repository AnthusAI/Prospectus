/**
 * Money in the billing pages is integer cents, parsed from the digits an operator typed. No floating point
 * touches an amount: the whole and fraction parts are read as digit strings.
 */

export type MoneyParse =
  | { ok: true; cents: number }
  | { ok: false; reason: "empty" | "format" | "precision" | "too_large" };

const MAX_WHOLE_DIGITS = 10;

/** Reads "1234.56", "$1,234.56" or "1234" as cents. More than two decimal places is refused, never rounded. */
export function parseCents(text: string): MoneyParse {
  const clean = text.replace(/[$\s]/g, "");
  if (clean === "") return { ok: false, reason: "empty" };
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d*))?$/.exec(clean);
  if (!match) return { ok: false, reason: "format" };
  const whole = match[1].replace(/,/g, "");
  const fraction = match[2] ?? "";
  if (fraction.length > 2) return { ok: false, reason: "precision" };
  if (whole.replace(/^0+(?=\d)/, "").length > MAX_WHOLE_DIGITS) return { ok: false, reason: "too_large" };
  return { ok: true, cents: Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2)) };
}

/** The sentence a form shows beside an amount that cannot be used. */
export function moneyProblem(parse: MoneyParse): string {
  if (parse.ok) return "";
  if (parse.reason === "precision") return "Use dollars and cents, with at most two decimal places.";
  if (parse.reason === "too_large") return "That amount is too large.";
  return "Enter an amount in dollars and cents, like 1234.56.";
}

/** "$6,500.00" from integer cents. */
export function formatCents(cents: number): string {
  const absolute = Math.abs(cents);
  const whole = String(Math.floor(absolute / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "−" : ""}$${whole}.${String(absolute % 100).padStart(2, "0")}`;
}

/** The digits to put back in an amount field: "5000.00" from 500000. */
export function centsToInput(cents: number): string {
  return formatCents(cents).replace(/[$,]/g, "");
}

/** Whole dollars for a stat: "$6,400" from 640000. */
export function formatWholeDollars(cents: number): string {
  return formatCents(Math.round(cents / 100) * 100).replace(/\.00$/, "");
}
