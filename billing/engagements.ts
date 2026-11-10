import { UUID_PATTERN } from "../accounts/model";
import { hasOnlyKeys, isPlainRecord, matchesStringPattern } from "../accounts/validation-rules";
import { addDays, isDate } from "./dates";
import { bare, checkExpectedRevision } from "./invoices";
import {
  engagementPath,
  MAXIMUM_INDEXED_RECORDS,
  type LedgerHandler,
  type LedgerOperation,
  type LedgerReader,
} from "./ledger-engine";
import { isCents } from "./money";
import {
  engagementTypes,
  fail,
  setupStages,
  type EngagementStatus,
  type EngagementType,
  type LedgerEngagement,
  type LedgerInvoice,
  type SetupStage,
} from "./model";

export const MAXIMUM_LENGTH_WEEKS = 104;
const text = (value: unknown, maximum: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
/** Messages name the field only, never the submitted value. */
const refuse = (message: string): never => fail(400, "invalid_engagement", `Engagement refused: ${message}`);

/** The engagement's fields as a create request carries them, already checked. */
export interface EngagementFields {
  name: string;
  type: EngagementType;
  status: "proposed" | "active";
  lead: string;
  startDate: string;
  monthlyAmountCents?: number;
  packagePriceCents?: number;
  lengthWeeks?: number;
  stage?: SetupStage;
}

const positiveCents = (value: unknown) => isCents(value) && (value as number) > 0;
const weeks = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAXIMUM_LENGTH_WEEKS;

/** Checks a new engagement. Amount fields belong to one type only; the other type's are refused. */
export function normalizeEngagement(input: unknown): EngagementFields {
  if (
    !isPlainRecord(input) ||
    !hasOnlyKeys(input, [
      "name",
      "type",
      "status",
      "lead",
      "startDate",
      "monthlyAmountCents",
      "packagePriceCents",
      "lengthWeeks",
      "stage",
    ])
  )
    return refuse("it must be an object with only the reviewed fields.");
  if (!text(input.name, 120)) refuse("the name must be 1 to 120 characters.");
  if (!engagementTypes.includes(input.type as EngagementType)) refuse("the type must be ongoing or setup.");
  const status = input.status ?? "active";
  if (status !== "proposed" && status !== "active") refuse("a new engagement is proposed or active.");
  if (!text(input.lead, 120)) refuse("the lead must be 1 to 120 characters.");
  if (!isDate(input.startDate)) refuse("the start date must be YYYY-MM-DD.");
  const type = input.type as EngagementType;
  if (type === "ongoing") {
    if (!positiveCents(input.monthlyAmountCents))
      refuse("an ongoing engagement needs a monthly amount of positive whole cents.");
    if (input.packagePriceCents !== undefined || input.lengthWeeks !== undefined || input.stage !== undefined)
      refuse("an ongoing engagement has no package price, length or stage.");
  } else {
    if (!positiveCents(input.packagePriceCents))
      refuse("a setup package needs a price of positive whole cents.");
    if (!weeks(input.lengthWeeks))
      refuse(`a setup package needs a length of 1 to ${MAXIMUM_LENGTH_WEEKS} weeks.`);
    if (input.monthlyAmountCents !== undefined) refuse("a setup package has no monthly amount.");
    if (input.stage !== undefined && !setupStages.includes(input.stage as SetupStage))
      refuse("the stage must be one of the setup stages.");
  }
  return {
    name: (input.name as string).trim(),
    type,
    status: status as "proposed" | "active",
    lead: (input.lead as string).trim(),
    startDate: input.startDate as string,
    ...(type === "ongoing"
      ? { monthlyAmountCents: input.monthlyAmountCents as number }
      : {
          packagePriceCents: input.packagePriceCents as number,
          lengthWeeks: input.lengthWeeks as number,
          stage: (input.stage as SetupStage | undefined) ?? "Installation",
        }),
  };
}

/** A change to an engagement: any of its editable fields, or a status move (start a proposed one, or end it). */
export interface EngagementChange {
  name?: string;
  lead?: string;
  startDate?: string;
  monthlyAmountCents?: number;
  packagePriceCents?: number;
  lengthWeeks?: number;
  stage?: SetupStage;
  status?: "active" | "ended";
  endDate?: string;
}
export const CHANGE_FIELDS = [
  "name",
  "lead",
  "startDate",
  "monthlyAmountCents",
  "packagePriceCents",
  "lengthWeeks",
  "stage",
  "status",
  "endDate",
] as const;

export function normalizeChange(input: Record<string, unknown>): EngagementChange {
  const change: EngagementChange = {};
  if (input.name !== undefined) {
    if (!text(input.name, 120)) refuse("the name must be 1 to 120 characters.");
    change.name = (input.name as string).trim();
  }
  if (input.lead !== undefined) {
    if (!text(input.lead, 120)) refuse("the lead must be 1 to 120 characters.");
    change.lead = (input.lead as string).trim();
  }
  if (input.startDate !== undefined) {
    if (!isDate(input.startDate)) refuse("the start date must be YYYY-MM-DD.");
    change.startDate = input.startDate as string;
  }
  if (input.monthlyAmountCents !== undefined) {
    if (!positiveCents(input.monthlyAmountCents)) refuse("the monthly amount must be positive whole cents.");
    change.monthlyAmountCents = input.monthlyAmountCents as number;
  }
  if (input.packagePriceCents !== undefined) {
    if (!positiveCents(input.packagePriceCents)) refuse("the package price must be positive whole cents.");
    change.packagePriceCents = input.packagePriceCents as number;
  }
  if (input.lengthWeeks !== undefined) {
    if (!weeks(input.lengthWeeks)) refuse(`the length must be 1 to ${MAXIMUM_LENGTH_WEEKS} weeks.`);
    change.lengthWeeks = input.lengthWeeks as number;
  }
  if (input.stage !== undefined) {
    if (!setupStages.includes(input.stage as SetupStage))
      refuse("the stage must be one of the setup stages.");
    change.stage = input.stage as SetupStage;
  }
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "ended")
      refuse("the status may only become active or ended.");
    change.status = input.status as "active" | "ended";
  }
  if (input.endDate !== undefined) {
    if (change.status !== "ended") refuse("an end date is given only when ending the engagement.");
    if (!isDate(input.endDate)) refuse("the end date must be YYYY-MM-DD.");
    change.endDate = input.endDate as string;
  }
  if (Object.keys(change).length === 0) refuse("nothing to change.");
  return change;
}

const setupEnd = (startDate: string, lengthWeeks: number) => addDays(startDate, lengthWeeks * 7);

async function requireEngagement(read: LedgerReader, operation: LedgerOperation) {
  const id = operation.request.engagementId;
  const engagement = typeof id === "string" ? await read.engagement(id) : null;
  if (!engagement || engagement.accountId !== operation.accountId)
    return fail(404, "engagement_missing", "Engagement not found.");
  checkExpectedRevision(operation, engagement.revision);
  return engagement;
}

/** Applies a checked change to the stored engagement, refusing fields of the other type and moves that cannot happen. */
export function applyChange(current: LedgerEngagement, change: EngagementChange, today: string) {
  if (current.status === "ended") fail(409, "engagement_ended", "An ended engagement cannot be changed.");
  if (
    current.type === "ongoing" &&
    (change.packagePriceCents !== undefined || change.lengthWeeks !== undefined || change.stage !== undefined)
  )
    refuse("an ongoing engagement has no package price, length or stage.");
  if (current.type === "setup" && change.monthlyAmountCents !== undefined)
    refuse("a setup package has no monthly amount.");
  if (change.status === "active" && current.status !== "proposed")
    fail(409, "engagement_started", "The engagement has already started.");
  const { status, endDate, ...fields } = change;
  const next: LedgerEngagement = { ...current, ...fields };
  if (next.type === "setup" && (fields.startDate !== undefined || fields.lengthWeeks !== undefined))
    next.endDate = setupEnd(next.startDate, next.lengthWeeks!);
  if (status === "active") next.status = "active";
  if (status === "ended") {
    next.status = "ended";
    next.endDate = endDate ?? today;
    if (next.endDate < next.startDate) refuse("the end date cannot be before the start date.");
  }
  return next;
}

export const createEngagementHandler: LedgerHandler = {
  recordKind: "engagement",
  async validate(read, operation) {
    const existing = await read.engagements(operation.accountId);
    if (existing.length >= MAXIMUM_INDEXED_RECORDS)
      fail(409, "billing_capacity", "The account has reached its engagement capacity.");
  },
  async execute(scope, operation) {
    const { engagementId, fields } = operation.request as { engagementId: string; fields: EngagementFields };
    const step = await scope.create<LedgerEngagement>(engagementPath(engagementId), "engagement.created", {
      version: 1,
      kind: "billing-engagement",
      id: engagementId,
      accountId: operation.accountId,
      ...fields,
      ...(fields.type === "setup" ? { endDate: setupEnd(fields.startDate, fields.lengthWeeks!) } : {}),
    });
    return {
      action: "engagement.created",
      primary: step,
      detail: { engagementId, type: fields.type, status: fields.status },
      index: { engagements: [engagementId] },
    };
  },
};

function changeHandler(action: "engagement.updated" | "engagement.ended"): LedgerHandler {
  return {
    recordKind: "engagement",
    async validate(read, operation) {
      const engagement = await requireEngagement(read, operation);
      applyChange(engagement, operation.request.change as EngagementChange, operation.at.slice(0, 10));
    },
    async execute(scope, operation) {
      const { engagementId, change } = operation.request as {
        engagementId: string;
        change: EngagementChange;
      };
      const step = await scope.step<LedgerEngagement>(engagementPath(engagementId), action, (current) => {
        if (!current) return fail(404, "engagement_missing", "Engagement not found.");
        return bare(applyChange(current, change, operation.at.slice(0, 10)));
      });
      return {
        action,
        primary: step,
        detail: {
          engagementId,
          status: step.record.status,
          ...(step.record.endDate && action === "engagement.ended" ? { endDate: step.record.endDate } : {}),
        },
      };
    },
  };
}
export const updateEngagementHandler = changeHandler("engagement.updated");
export const endEngagementHandler = changeHandler("engagement.ended");

export const isEngagementId = (value: unknown): value is string => matchesStringPattern(value, UUID_PATTERN);

// ---- Derived figures ---------------------------------------------------------------------------------------

export interface LastInvoiced {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: string;
  period?: string;
}
const counts = (invoice: LedgerInvoice) =>
  invoice.lifecycle !== "draft" && invoice.lifecycle !== "void" && !!invoice.issueDate && !!invoice.number;

/** The latest issued, non-void invoice with a line naming the engagement. */
export function lastInvoiced(engagementId: string, invoices: readonly LedgerInvoice[]): LastInvoiced | null {
  let best: LastInvoiced | null = null;
  for (const invoice of invoices) {
    if (!counts(invoice)) continue;
    const line = invoice.lineItems.find((item) => item.engagementId === engagementId);
    if (!line) continue;
    if (best && best.issueDate >= invoice.issueDate!) continue;
    best = {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number!,
      issueDate: invoice.issueDate!,
      ...(line.period ? { period: line.period } : {}),
    };
  }
  return best;
}

/**
 * The last complete calendar month (UTC, `YYYY-MM`) of an active ongoing engagement that no invoice covers yet, or
 * null. A month counts as invoiced when an issued invoice naming the engagement was issued on or after its first
 * day, which covers billing in arrears and in advance alike.
 */
export function uninvoicedMonth(
  engagement: Pick<LedgerEngagement, "id" | "type" | "status" | "startDate">,
  invoices: readonly LedgerInvoice[],
  today: string,
): string | null {
  if (engagement.type !== "ongoing" || engagement.status !== "active") return null;
  const year = Number(today.slice(0, 4)),
    month = Number(today.slice(5, 7));
  const previous = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
  const first = `${previous}-01`;
  // A month the engagement had not started by its last day is not owed.
  const lastDay = addDays(`${today.slice(0, 7)}-01`, -1);
  if (engagement.startDate > lastDay) return null;
  const covered = invoices.some(
    (invoice) =>
      counts(invoice) &&
      invoice.issueDate! >= first &&
      invoice.lineItems.some((item) => item.engagementId === engagement.id),
  );
  return covered ? null : previous;
}

export type { EngagementStatus };
