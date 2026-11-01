import type { IdentityFiles } from "../accounts/identity-files";
import type { Context } from "../accounts/model";
import type { OperatorGrant } from "../accounts/operator-policy";
import {
  hasOnlyKeys,
  isPlainRecord,
  requireRules,
  rule,
  type ValidationRule,
} from "../accounts/validation-rules";
import {
  fail,
  failWith,
  isOpenLine,
  type BillingAction,
  type BillingLine,
  type BillingProfile,
  type EndedLineFollowUp,
} from "./model";
import { productFamily, type BillingPlanCatalog } from "./plans";
import { requireBillingAdministrator } from "./profile";
import {
  isJournaled,
  linePath,
  liveReservations,
  mutate,
  profilePath,
  readLines,
  requireAccountId,
  requireExpectedRevision,
  requireOperationId,
  requireProduct,
  updateOpenLines,
} from "./store";

/** Read-only views of access. In production both call the central accounts service; billing never writes them. */
export interface BillingLinePorts {
  entitlements(accountId: string): Promise<Record<string, "active" | "disabled">>;
  isPublicReader(product: string): boolean | Promise<boolean>;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value: unknown): value is string =>
  typeof value === "string" &&
  DATE_PATTERN.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const createRules: ValidationRule<any>[] = [
  rule((input) => isPlainRecord(input), "Billing line must be an object."),
  rule(
    (input) => hasOnlyKeys(input, ["plan", "startDate", "expectedRevision"]),
    "Billing line must have only the reviewed fields.",
  ),
  rule((input) => typeof input.plan === "string", "Billing line plan must be a plan ID."),
  rule(
    (input) => input.startDate === undefined || isDate(input.startDate),
    "Billing line start date must be absent or a YYYY-MM-DD date.",
  ),
];
const changeRules = (dateField?: string): ValidationRule<any>[] => [
  rule((input) => isPlainRecord(input), "Billing line change must be an object."),
  rule(
    (input) => hasOnlyKeys(input, ["expectedRevision", ...(dateField ? [dateField] : [])]),
    "Billing line change must have only the reviewed fields.",
  ),
  ...(dateField
    ? [
        rule(
          (input: any) => input[dateField] === undefined || isDate(input[dateField]),
          "Billing line end date must be absent or a YYYY-MM-DD date.",
        ),
      ]
    : []),
];
const refuse = failWith(400, "invalid_billing_line", "Billing line refused");

/** One line per account and product. Each Papyrus site is its own product, so each deployment is its own line.
 * Every operation writes its own line file and one journal event, and no line ever touches another. Opening and
 * ending a line also update the open-line reservations on the account's profile, the record a mode switch writes. */
export class BillingLines {
  constructor(
    private files: IdentityFiles,
    private grants: readonly OperatorGrant[],
    private plans: BillingPlanCatalog,
    private ports: BillingLinePorts,
    private now: () => string = () => new Date().toISOString(),
  ) {}
  async get(accountId: string, product: string): Promise<BillingLine | null> {
    return (
      (await this.files.get<BillingLine>(linePath(requireAccountId(accountId), requireProduct(product))))
        ?.value ?? null
    );
  }
  async list(accountId: string): Promise<BillingLine[]> {
    return readLines(this.files, requireAccountId(accountId));
  }

  async create(context: Context, accountId: string, product: string, input: unknown, operationId: string) {
    const actor = requireBillingAdministrator(context, this.grants);
    const id = requireAccountId(accountId),
      name = requireProduct(product),
      operation = requireOperationId(operationId);
    requireRules(input, createRules, refuse);
    const { plan: planId, startDate } = input as { plan: string; startDate?: string };
    const expectedRevision = requireExpectedRevision((input as any).expectedRevision);
    const plan = this.plans.get(planId);
    if (!plan) fail(400, "unknown_plan", "Billing line plan must be in the reviewed catalog.");
    const family = productFamily(name);
    if (!family) fail(400, "unbillable_product", `Product ${name} has no billing plan family.`);
    if (plan.family !== family)
      fail(
        400,
        "plan_family_mismatch",
        `Plan ${plan.planId} is for ${plan.family}, not ${family} product ${name}.`,
      );
    if (await this.ports.isPublicReader(name))
      fail(400, "public_reader_product", `Public-reader product ${name} is never billed.`);
    const path = linePath(id, name);
    const current = (await this.files.get<BillingLine>(path))?.value;
    const committed =
      (await isJournaled(this.files, "line", id, name, operation)) ||
      !!current?.audit.some((entry) => entry.operationId === operation);
    // Reserve first, on the profile: a concurrent mode switch then either lands before (and this line opens under
    // the new mode) or sees the reservation and is refused. The same goes for a concurrent line of another interval.
    if (!committed)
      await updateOpenLines(this.files, id, `reserve:${name}:${operation}`, async (profile) => {
        if (profile?.openLines?.[name]?.operationId === operation) return null;
        if (!profile?.mode)
          fail(409, "not_yet_billable", "Account has no billing mode, so it is not yet billable.");
        const live = await liveReservations(this.files, profile, this.now());
        if (live[name]) fail(409, "line_exists", `Product ${name} already has an open billing line.`);
        if ((await this.ports.entitlements(id))[name] !== "active")
          fail(409, "entitlement_required", `Account has no active entitlement for product ${name}.`);
        if (profile.mode === "direct") {
          const other = Object.values(live).find((reservation) => reservation.interval !== plan.interval);
          if (other)
            fail(
              409,
              "interval_mismatch",
              `Direct billing uses one subscription, so plan interval ${plan.interval} must match the open lines billed per ${other.interval}.`,
            );
        }
        return {
          ...live,
          [name]: { operationId: operation, interval: plan.interval, reservedAt: this.now() },
        };
      });
    const { record, replayed } = await mutate<BillingLine>(this.files, {
      action: "line.created",
      recordKind: "line",
      path,
      accountId: id,
      product: name,
      operationId: operation,
      actor,
      request: { plan: plan.planId, startDate: startDate ?? null },
      expectedRevision,
      at: this.now(),
      apply: async (current) => {
        if (current && isOpenLine(current))
          fail(409, "line_exists", `Product ${name} already has an open billing line.`);
        // The reservation holds the mode in place: no switch passes it, so the profile's mode is this line's.
        const profile = (await this.files.get<BillingProfile>(profilePath(id)))?.value;
        if (profile?.openLines?.[name]?.operationId !== operation || !profile.mode)
          fail(409, "busy", "Concurrent billing change; retry.");
        return {
          version: 1,
          kind: "billing-line",
          accountId: id,
          product: name,
          planId: plan.planId,
          family: plan.family,
          interval: plan.interval,
          mode: profile.mode,
          status: profile.mode === "direct" ? "pending" : "active",
          openedBy: operation,
          period: { start: startDate ?? this.now().slice(0, 10) },
        };
      },
    });
    return { line: record, replayed };
  }

  pause(context: Context, accountId: string, product: string, input: unknown, operationId: string) {
    return this.change(context, accountId, product, input, operationId, "line.paused", (line) => {
      if (line.status !== "active")
        fail(409, "invalid_transition", "Only an active billing line can be paused.");
      return { ...line, status: "paused" };
    });
  }
  resume(context: Context, accountId: string, product: string, input: unknown, operationId: string) {
    return this.change(context, accountId, product, input, operationId, "line.resumed", (line) => {
      if (line.status !== "paused")
        fail(409, "invalid_transition", "Only a paused billing line can be resumed.");
      return { ...line, status: "active" };
    });
  }
  /** Ends the line and leaves the entitlement alone, returning a follow-up about disabling the product. */
  async end(context: Context, accountId: string, product: string, input: unknown, operationId: string) {
    const result = await this.change(
      context,
      accountId,
      product,
      input,
      operationId,
      "line.ended",
      async (line, request) => {
        if (line.status === "ended") fail(409, "invalid_transition", "The billing line has already ended.");
        const end = (request.endDate as string | undefined) ?? this.now().slice(0, 10);
        if (end < line.period.start)
          fail(
            400,
            "invalid_billing_line",
            "Billing line refused: end date must not precede the start date.",
          );
        const entitlementStatus = (await this.ports.entitlements(line.accountId))[line.product] ?? "missing";
        const endFollowUp: EndedLineFollowUp = {
          type: "consider-disabling-product",
          accountId: line.accountId,
          product: line.product,
          disableProduct: entitlementStatus === "active",
          entitlementStatus,
        };
        return { ...line, status: "ended", period: { ...line.period, end }, endFollowUp };
      },
      "endDate",
    );
    // Release after the line has ended, so a mode switch never sees no reservation while the line is still open.
    // A replay of the same end finishes a release that did not complete.
    const { accountId: id, product: name, openedBy } = result.line;
    await updateOpenLines(this.files, id, `release:${name}:${openedBy}`, (profile) => {
      if (!profile?.openLines || profile.openLines[name]?.operationId !== openedBy) return null;
      const { [name]: _released, ...rest } = profile.openLines;
      return rest;
    });
    return { ...result, followUp: result.line.endFollowUp! };
  }

  private async change(
    context: Context,
    accountId: string,
    product: string,
    input: unknown,
    operationId: string,
    action: BillingAction,
    transition: (line: BillingLine, request: Record<string, unknown>) => BillingLine | Promise<BillingLine>,
    dateField?: string,
  ) {
    const actor = requireBillingAdministrator(context, this.grants);
    const id = requireAccountId(accountId),
      name = requireProduct(product),
      operation = requireOperationId(operationId);
    requireRules(input, changeRules(dateField), refuse);
    const expectedRevision = requireExpectedRevision((input as any).expectedRevision);
    const request: Record<string, unknown> =
      dateField && (input as any)[dateField] !== undefined ? { [dateField]: (input as any)[dateField] } : {};
    const { record, replayed } = await mutate<BillingLine>(this.files, {
      action,
      recordKind: "line",
      path: linePath(id, name),
      accountId: id,
      product: name,
      operationId: operation,
      actor,
      request,
      expectedRevision,
      at: this.now(),
      apply: async (current) => {
        if (!current) fail(404, "line_missing", `Product ${name} has no billing line.`);
        const {
          revision: _revision,
          creation: _creation,
          audit: _audit,
          ...line
        } = await transition(current, request);
        return line;
      },
    });
    return { line: record, replayed };
  }
}
