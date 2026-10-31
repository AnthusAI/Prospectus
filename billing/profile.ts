import type { IdentityFiles } from "../accounts/identity-files";
import type { Context } from "../accounts/model";
import { billingAdministrationGrant, type OperatorGrant } from "../accounts/operator-policy";
import {
  hasOnlyKeys,
  isPlainRecord,
  requireRules,
  rule,
  type ValidationRule,
} from "../accounts/validation-rules";
import {
  BILLING_CURRENCY,
  billingModes,
  DEFAULT_NET_TERMS_DAYS,
  fail,
  failWith,
  isOpenLine,
  paymentMethodKinds,
  type BillingContact,
  type BillingMode,
  type BillingProfile,
  type PaymentMethodKind,
} from "./model";
import {
  mutate,
  profilePath,
  readLines,
  requireAccountId,
  requireExpectedRevision,
  requireOperationId,
} from "./store";

export interface BillingProfileInput {
  mode?: BillingMode;
  currency: string;
  billingContact: BillingContact;
  netTermsDays?: number;
  paymentMethods?: PaymentMethodKind[];
  /** The profile revision the admin edited, or 0 for a new profile. Absent: apply to whatever is current. */
  expectedRevision?: number;
}

const inputKeys = [
  "mode",
  "currency",
  "billingContact",
  "netTermsDays",
  "paymentMethods",
  "expectedRevision",
];
const contactKeys = ["name", "email", "address", "taxId"];
const addressKeys = ["line1", "line2", "city", "region", "postalCode", "country"];
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const MAXIMUM_NET_TERMS_DAYS = 365;

const text = (value: unknown, maximum: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const optionalText = (value: unknown, maximum: number) => value === undefined || text(value, maximum);

// Every message names the field only; no rule ever echoes a submitted value.
const addressRules: ValidationRule<any>[] = [
  rule((address) => isPlainRecord(address), "Billing contact address must be an object."),
  rule(
    (address) => hasOnlyKeys(address, addressKeys),
    "Billing contact address must have only the reviewed fields.",
  ),
  rule((address) => text(address.line1, 200), "Billing contact address line 1 must be 1 to 200 characters."),
  rule(
    (address) => optionalText(address.line2, 200),
    "Billing contact address line 2 must be absent or 1 to 200 characters.",
  ),
  rule((address) => text(address.city, 100), "Billing contact city must be 1 to 100 characters."),
  rule(
    (address) => optionalText(address.region, 100),
    "Billing contact region must be absent or 1 to 100 characters.",
  ),
  rule((address) => text(address.postalCode, 32), "Billing contact postal code must be 1 to 32 characters."),
  rule(
    (address) => typeof address.country === "string" && COUNTRY_PATTERN.test(address.country),
    "Billing contact country must be a two-letter ISO country code.",
  ),
];
const contactRules: ValidationRule<any>[] = [
  rule((contact) => isPlainRecord(contact), "Billing contact must be an object."),
  rule((contact) => hasOnlyKeys(contact, contactKeys), "Billing contact must have only the reviewed fields."),
  rule((contact) => text(contact.name, 200), "Billing contact name must be 1 to 200 characters."),
  rule(
    (contact) => typeof contact.email === "string" && EMAIL_PATTERN.test(contact.email),
    "Billing contact email must be an email address.",
  ),
  rule(
    (contact) => optionalText(contact.taxId, 64),
    "Billing contact tax ID must be absent or 1 to 64 characters.",
  ),
];
const inputRules: ValidationRule<any>[] = [
  rule((input) => isPlainRecord(input), "Billing profile must be an object."),
  rule((input) => hasOnlyKeys(input, inputKeys), "Billing profile must have only the reviewed fields."),
  rule(
    (input) => input.mode === undefined || (billingModes as readonly unknown[]).includes(input.mode),
    "Billing mode must be direct, invoiced or absent.",
  ),
  rule((input) => input.currency === BILLING_CURRENCY, "Billing currency must be usd."),
  rule(
    (input) =>
      input.netTermsDays === undefined ||
      (Number.isSafeInteger(input.netTermsDays) &&
        input.netTermsDays >= 1 &&
        input.netTermsDays <= MAXIMUM_NET_TERMS_DAYS),
    "Net terms must be absent or a whole number of days from 1 to 365.",
  ),
  rule(
    (input) =>
      input.paymentMethods === undefined ||
      (Array.isArray(input.paymentMethods) &&
        input.paymentMethods.length >= 1 &&
        input.paymentMethods.every((method: unknown) =>
          (paymentMethodKinds as readonly unknown[]).includes(method),
        ) &&
        new Set(input.paymentMethods).size === input.paymentMethods.length),
    "Payment methods must be absent or a list of distinct known payment methods.",
  ),
];

function normalizedContact(contact: any): BillingContact {
  const address = contact.address;
  return {
    name: contact.name,
    email: contact.email,
    ...(address
      ? {
          address: {
            line1: address.line1,
            ...(address.line2 !== undefined ? { line2: address.line2 } : {}),
            city: address.city,
            ...(address.region !== undefined ? { region: address.region } : {}),
            postalCode: address.postalCode,
            country: address.country,
          },
        }
      : {}),
    ...(contact.taxId !== undefined ? { taxId: contact.taxId } : {}),
  };
}

/** Validates and normalizes a profile write into a fixed key order, so equal requests hash equally. */
export function billingProfileInput(input: unknown) {
  const refuse = failWith(400, "invalid_billing_profile", "Billing profile refused");
  requireRules(input, inputRules, refuse);
  const value = input as BillingProfileInput;
  requireRules(value.billingContact, contactRules, refuse);
  if (value.billingContact.address !== undefined)
    requireRules(value.billingContact.address, addressRules, refuse);
  return {
    expectedRevision: requireExpectedRevision(value.expectedRevision),
    request: {
      ...(value.mode ? { mode: value.mode } : {}),
      currency: BILLING_CURRENCY as typeof BILLING_CURRENCY,
      billingContact: normalizedContact(value.billingContact),
      ...(value.netTermsDays !== undefined ? { netTermsDays: value.netTermsDays } : {}),
      ...(value.paymentMethods ? { paymentMethods: [...value.paymentMethods] } : {}),
    },
  };
}

export const effectiveNetTermsDays = (profile: Pick<BillingProfile, "netTermsDays">) =>
  profile.netTermsDays ?? DEFAULT_NET_TERMS_DAYS;

/** The administering operator's reviewed grant ID, or 403 before anything is read or written. */
export function requireBillingAdministrator(context: Context, grants: readonly OperatorGrant[]) {
  const grant = billingAdministrationGrant(context, grants);
  if (!grant) fail(403, "forbidden", "The accounts:admin:billing permission is required.");
  return grant.reviewedGrantId;
}

/** One billing profile per account, beside the account and never inside it. Only billing admins write it. */
export class BillingProfiles {
  constructor(
    private files: IdentityFiles,
    private grants: readonly OperatorGrant[],
    private now: () => string = () => new Date().toISOString(),
  ) {}
  async get(accountId: string): Promise<BillingProfile | null> {
    return (await this.files.get<BillingProfile>(profilePath(requireAccountId(accountId))))?.value ?? null;
  }
  /** Replaces the profile. A mode change is refused while the account has open lines, naming them. */
  async set(context: Context, accountId: string, input: unknown, operationId: string) {
    const actor = requireBillingAdministrator(context, this.grants);
    const id = requireAccountId(accountId),
      operation = requireOperationId(operationId),
      { request, expectedRevision } = billingProfileInput(input);
    const { record, replayed } = await mutate<BillingProfile>(this.files, {
      action: "profile.set",
      recordKind: "profile",
      path: profilePath(id),
      accountId: id,
      operationId: operation,
      actor,
      request,
      expectedRevision,
      at: this.now(),
      apply: async (current) => {
        if ((current?.mode ?? null) !== (request.mode ?? null)) {
          const openLines = (await readLines(this.files, id)).filter(isOpenLine).map((line) => line.product);
          if (openLines.length)
            fail(
              409,
              "open_billing_lines",
              `Billing mode cannot change while lines are open; end or re-home each first: ${openLines.join(", ")}.`,
            );
        }
        return {
          version: 1,
          kind: "billing-profile",
          accountId: id,
          ...request,
          status: "active",
          ...(current?.stripeCustomerId ? { stripeCustomerId: current.stripeCustomerId } : {}),
        };
      },
    });
    return { profile: record, replayed };
  }
}
