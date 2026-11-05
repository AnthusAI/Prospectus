/** Calendar dates are `YYYY-MM-DD` strings; day arithmetic is whole days in UTC, with no rounding. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = 86_400_000;

export const isDate = (value: unknown): value is string =>
  typeof value === "string" &&
  DATE_PATTERN.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const isMonth = (value: unknown): value is string =>
  typeof value === "string" && MONTH_PATTERN.test(value);
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
/** Whole days from `from` to `to`; negative when `to` is earlier. */
export const daysBetween = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY;
