import { AccountsClientError, type Transport } from "./client.js";

/** Every amount is an integer number of US cents of cloud cost. One allowance per account, shared by every app. */
export const QUOTA_UNIT = "usd-cents";

export interface QuotaSummary {
  unit: typeof QUOTA_UNIT;
  allowanceCents: number;
  usedCents: number;
  /** Held by reservations that have not expired. */
  heldCents: number;
  /** The part of usedCents that no reservation covered, each time explicitly acknowledged. */
  overageCents: number;
  /** Allowance minus used minus held; negative after an acknowledged overage or a lowered allowance. */
  remainingCents: number;
  byProduct: Array<{ product: string; usedCents: number; heldCents: number }>;
}
/** What the CRM and portal show. `unavailable` means the numbers could not be read, never zero or unlimited. */
export type QuotaView = { state: "unavailable" } | { state: "none" } | ({ state: "set" } & QuotaSummary);

export interface ReserveRequest {
  /** A client-generated UUID. It becomes the reservation ID, and repeating the call with it is safe. */
  operationId: string;
  /** The most the job can cost. The reservation succeeds only if the account's remaining quota covers it. */
  maxCents: number;
  /** How long the hold lasts if the job is never settled or released. */
  expiresInSeconds: number;
}
export interface Reservation {
  reservationId: string;
  accountId: string;
  status: "reserved";
  maxCents: number;
  expiresAt: string;
}
export interface SettleRequest {
  /** A client-generated UUID for this settle; repeating the call with it is safe. */
  operationId: string;
  actualCents: number;
  /** Required to record a cost above the reservation, or any cost after the reservation expired. */
  allowOverage?: boolean;
}
export interface Settlement {
  reservationId: string;
  accountId: string;
  status: "settled" | "settled_late";
  chargedCents: number;
  releasedCents: number;
  overageCents: number;
}
export interface ReleaseRequest {
  operationId: string;
}
export interface Release {
  reservationId: string;
  accountId: string;
  status: "released";
  releasedCents: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Rejects a 200 whose body is not exactly the expected outcome, so a proxy page or a changed service reads as a
 * refusal and never as permission to spend. */
function expect<T>(value: unknown, statuses: string[], integers: string[]): T {
  if (
    !isRecord(value) ||
    typeof value.reservationId !== "string" ||
    typeof value.status !== "string" ||
    !statuses.includes(value.status) ||
    integers.some((key) => !Number.isSafeInteger(value[key]))
  )
    throw new AccountsClientError(
      502,
      "quota_response",
      "Quota returned an unexpected response; do not spend.",
    );
  return value as T;
}

/** Reserve, settle and release. Any refusal, error or odd response throws: treat a throw as no permission to spend. */
export class QuotaClient {
  constructor(private transport: Transport) {}
  async reserve(accountId: string, request: ReserveRequest): Promise<Reservation> {
    const body = await this.transport(
      `/v1/quota/accounts/${encodeURIComponent(accountId)}/reservations`,
      "POST",
      request,
    );
    const reservation = expect<Reservation>(body, ["reserved"], ["maxCents"]);
    if (typeof reservation.expiresAt !== "string")
      throw new AccountsClientError(
        502,
        "quota_response",
        "Quota returned an unexpected response; do not spend.",
      );
    return reservation;
  }
  async settle(accountId: string, reservationId: string, request: SettleRequest): Promise<Settlement> {
    return expect<Settlement>(
      await this.transport(
        `/v1/quota/accounts/${encodeURIComponent(accountId)}/reservations/${encodeURIComponent(reservationId)}/settle`,
        "POST",
        request,
      ),
      ["settled", "settled_late"],
      ["chargedCents", "releasedCents", "overageCents"],
    );
  }
  async release(accountId: string, reservationId: string, request: ReleaseRequest): Promise<Release> {
    return expect<Release>(
      await this.transport(
        `/v1/quota/accounts/${encodeURIComponent(accountId)}/reservations/${encodeURIComponent(reservationId)}/release`,
        "POST",
        request,
      ),
      ["released"],
      ["releasedCents"],
    );
  }
}
