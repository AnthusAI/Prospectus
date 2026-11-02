import { AccountsClientError, type Transport } from "./client.js";

/** One billable thing a product did or expects to do. Products report what happened, never what it cost: Prospectus
 * converts items to usage with a private rate table. `itemKind` is an open, namespaced name such as
 * `openai.tokens.input`, `jev.tokens`, `aws.bedrock.tokens.<model>`, `aws.batch.vcpu_seconds` or
 * `aws.lambda.gb_seconds`. An item kind the table does not know is refused. */
export interface BillableItem {
  itemKind: string;
  /** A whole number of the kind's own unit. */
  quantity: number;
}

/** What a customer sees: one number, the share of this week's quota used, and when it resets. No money, no rates. */
export type QuotaView =
  | { state: "unavailable" }
  | { state: "none" }
  | {
      state: "set";
      /** 0 to 100, whole percent, capped at 100. */
      percentUsed: number;
      /** When this week's quota resets. */
      resetsAt: string;
      /** Each app's contribution to percentUsed, in whole percent of the quota. */
      byProduct: Array<{ product: string; percentOfQuota: number }>;
    };

/** What staff see in the CRM: the customer view plus Prospectus's internal usage units. The rate table is never shown. */
export type OperatorQuotaView =
  | { state: "unavailable" }
  | { state: "none"; planId: string | null; allowanceOverrideUnits: number | null }
  | {
      state: "set";
      percentUsed: number;
      resetsAt: string;
      startedAt: string;
      byProduct: Array<{ product: string; percentOfQuota: number }>;
      planId: string | null;
      allowanceOverrideUnits: number | null;
      allowanceUnits: number;
      usedUnits: number;
      heldUnits: number;
      /** Units recorded beyond the allowance this week by pay-after usage. Customers see 100 at most. */
      overshootUnits: number;
      /** The rate table versions whose charges are in this week. */
      tableVersions: string[];
    };

export interface ReserveRequest {
  /** A client-generated UUID. It becomes the reservation ID, and repeating the call with it is safe. */
  operationId: string;
  /** The most the work can use. The reservation succeeds only if this week's remaining quota covers it. */
  items: BillableItem[];
  /** How long the hold lasts if the work is never settled or released. */
  expiresInSeconds: number;
}
export interface Reservation {
  reservationId: string;
  accountId: string;
  status: "reserved";
  expiresAt: string;
}
export interface SettleRequest {
  /** A client-generated UUID for this settle; repeating the call with it is safe. */
  operationId: string;
  /** What the work actually used. */
  items: BillableItem[];
}
export interface Settlement {
  reservationId: string;
  accountId: string;
  status: "settled";
}
export interface ReleaseRequest {
  operationId: string;
}
export interface Release {
  reservationId: string;
  accountId: string;
  status: "released";
}
export interface RecordRequest {
  /** A client-generated UUID for this batch; repeating the call with it is safe. */
  operationId: string;
  items: BillableItem[];
}
export interface Recorded {
  accountId: string;
  status: "recorded";
}
export interface Check {
  /** True while this week's quota is below 100%. */
  allowed: boolean;
  percentUsed: number;
  resetsAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const unexpected = () =>
  new AccountsClientError(502, "quota_response", "Quota returned an unexpected response; do not spend.");

/** Rejects a 200 whose body is not exactly the expected outcome, so a proxy page or a changed service reads as a
 * refusal and never as permission to spend. */
function expect<T>(value: unknown, status: string): T {
  if (!isRecord(value) || value.status !== status || typeof value.accountId !== "string") throw unexpected();
  return value as T;
}

/** Reserve, settle, release, record and check. Any refusal, error or odd response throws: treat a throw as no
 * permission to spend. */
export class QuotaClient {
  constructor(private transport: Transport) {}
  private account(accountId: string, tail: string) {
    return `/v1/quota/accounts/${encodeURIComponent(accountId)}/${tail}`;
  }
  /** Cheap read for high-volume, small work (tokens, Lambda): may this account start work now? */
  async check(accountId: string): Promise<Check> {
    const body = await this.transport(this.account(accountId, "check"), "POST", {});
    if (
      !isRecord(body) ||
      typeof body.allowed !== "boolean" ||
      !Number.isSafeInteger(body.percentUsed) ||
      typeof body.resetsAt !== "string"
    )
      throw unexpected();
    return body as unknown as Check;
  }
  /** Pay after: records what the work actually used. Batch many items per call and repeat a failed call unchanged. */
  async record(accountId: string, request: RecordRequest): Promise<Recorded> {
    return expect<Recorded>(
      await this.transport(this.account(accountId, "usage"), "POST", request),
      "recorded",
    );
  }
  /** Reserve for expensive work (Batch, renders). Start the work only after this returns. */
  async reserve(accountId: string, request: ReserveRequest): Promise<Reservation> {
    const body = expect<Reservation>(
      await this.transport(this.account(accountId, "reservations"), "POST", request),
      "reserved",
    );
    if (typeof body.reservationId !== "string" || typeof body.expiresAt !== "string") throw unexpected();
    return body;
  }
  async settle(accountId: string, reservationId: string, request: SettleRequest): Promise<Settlement> {
    return expect<Settlement>(
      await this.transport(
        this.account(accountId, `reservations/${encodeURIComponent(reservationId)}/settle`),
        "POST",
        request,
      ),
      "settled",
    );
  }
  async release(accountId: string, reservationId: string, request: ReleaseRequest): Promise<Release> {
    return expect<Release>(
      await this.transport(
        this.account(accountId, `reservations/${encodeURIComponent(reservationId)}/release`),
        "POST",
        request,
      ),
      "released",
    );
  }
}
