import reviewedCatalog from "../accounts/billing-plans.json";
import {
  PAPYRUS_SITE_PRODUCT_PATTERN,
  hasExactlyKeys,
  isPlainRecord,
  matchesStringPattern,
  requireRules,
  rule,
  throwErrorWithPrefix,
  type ValidationRule,
} from "../accounts/validation-rules";
import { planFamilies, planIntervals, type PlanFamily, type PlanInterval } from "./model";

/** One reviewed plan. Amounts are integer US cents; display names of products come from site metadata. */
export interface BillingPlan {
  planId: string;
  displayName: string;
  family: PlanFamily;
  interval: PlanInterval;
  amountCents: number;
  stripePriceIds: { test: string; live: string | null };
}
export type BillingPlanCatalog = ReadonlyMap<string, Readonly<BillingPlan>>;

const MAXIMUM_PLANS = 100;
const MAXIMUM_AMOUNT_CENTS = 100_000_000;
const PLAN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]{1,200}$/;
const planKeys = "amountCents,displayName,family,interval,planId,stripePriceIds";
const priceKeys = "live,test";

const planRules: ValidationRule<BillingPlan>[] = [
  rule((plan) => isPlainRecord(plan), "A billing plan must be an object."),
  rule((plan) => hasExactlyKeys(plan, planKeys), "A billing plan must have exactly the reviewed fields."),
  rule(
    (plan) => matchesStringPattern(plan.planId, PLAN_ID_PATTERN),
    "A billing plan ID must be lowercase letters, digits and hyphens, starting with a letter.",
  ),
  rule(
    (plan) =>
      typeof plan.displayName === "string" &&
      plan.displayName.trim().length > 0 &&
      plan.displayName.length <= 80,
    "A billing plan display name must be 1 to 80 characters.",
  ),
  rule(
    (plan) => (planFamilies as readonly unknown[]).includes(plan.family),
    "A billing plan family must be papyrus or cyclotron-lab.",
  ),
  rule(
    (plan) => (planIntervals as readonly unknown[]).includes(plan.interval),
    "A billing plan interval must be month or year.",
  ),
  rule(
    (plan) =>
      Number.isSafeInteger(plan.amountCents) &&
      plan.amountCents >= 0 &&
      plan.amountCents <= MAXIMUM_AMOUNT_CENTS,
    "A billing plan amount must be a whole number of cents from 0 to 100000000.",
  ),
  rule(
    (plan) => isPlainRecord(plan.stripePriceIds) && hasExactlyKeys(plan.stripePriceIds, priceKeys),
    "A billing plan must have a Stripe price ID for exactly the test and live modes.",
  ),
  rule(
    (plan) => matchesStringPattern(plan.stripePriceIds.test, PRICE_ID_PATTERN),
    "A billing plan test-mode price ID must be a Stripe price ID.",
  ),
  rule(
    (plan) =>
      plan.stripePriceIds.live === null || matchesStringPattern(plan.stripePriceIds.live, PRICE_ID_PATTERN),
    "A billing plan live-mode price ID must be null or a Stripe price ID.",
  ),
];

/** Validates the reviewed catalog. Called at service start and at synthesis, so a bad catalog never serves. */
export function billingPlans(value: unknown): BillingPlanCatalog {
  if (!Array.isArray(value)) throw new Error("The reviewed billing plan catalog must be an array of plans.");
  if (value.length > MAXIMUM_PLANS)
    throw new Error("The billing plan catalog exceeds the maximum of 100 plans.");
  const plans = new Map<string, Readonly<BillingPlan>>(),
    priceIds = new Set<string>();
  for (const plan of value as BillingPlan[]) {
    requireRules(plan, planRules, throwErrorWithPrefix("Exact reviewed billing plan required:"));
    if (plans.has(plan.planId)) throw new Error("Each billing plan needs its own plan ID.");
    for (const priceId of [plan.stripePriceIds.test, plan.stripePriceIds.live])
      if (priceId !== null) {
        if (priceIds.has(priceId))
          throw new Error("Each Stripe price ID may belong to only one billing plan.");
        priceIds.add(priceId);
      }
    plans.set(
      plan.planId,
      Object.freeze({ ...plan, stripePriceIds: Object.freeze({ ...plan.stripePriceIds }) }),
    );
  }
  return plans;
}

export const reviewedBillingPlans = (): BillingPlanCatalog => billingPlans(reviewedCatalog);

/** The plan family a product is billed under: every Papyrus site is its own papyrus product. */
export function productFamily(product: string): PlanFamily | undefined {
  if (PAPYRUS_SITE_PRODUCT_PATTERN.test(product)) return "papyrus";
  if (product === "cyclotron") return "cyclotron-lab";
  return undefined;
}
