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
  DEFAULT_NET_TERMS_DAYS,
  failWith,
  type AcceptedPaymentMethod,
  type IssuerBlock,
  type IssuerRecord,
} from "./model";
import { requireBillingAdministrator } from "./profile";
import { mutate, requireExpectedRevision, requireOperationId } from "./store";

/** The one issuer record. Its file name is a single hex digit because the bridge accepts only hex and hyphens. */
export const ISSUER_PATH = "issuer/0.json";

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const text = (value: unknown, maximum: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const optionalText = (value: unknown, maximum: number) => value === undefined || text(value, maximum);
/** Links in payment instructions (a Melio payment link, say) are https only: no http, javascript, data or other scheme. */
export const LINK_PATTERN = /\b[a-z][a-z0-9+.-]*:(?:\/\/)?[^\s<>"']+/gi;
export const linksIn = (instructions: string) =>
  [...instructions.matchAll(LINK_PATTERN)]
    .map((match) => match[0])
    .filter(
      (link) =>
        /^[a-z][a-z0-9+.-]*:\/\//i.test(link) || /^(javascript|data|vbscript|file|mailto):/i.test(link),
    );
export const onlyHttpsLinks = (instructions: string) =>
  linksIn(instructions).every((link) => /^https:\/\/[^\s/]+/i.test(link));
const refuse = failWith(400, "invalid_issuer", "Issuer refused");

// Messages name the field only; no rule echoes a submitted value, since an issuer block is private data.
const issuerRules: ValidationRule<any>[] = [
  rule((input) => isPlainRecord(input), "Issuer must be an object."),
  rule(
    (input) =>
      hasOnlyKeys(input, [
        "issuer",
        "paymentMethods",
        "defaultNetTermsDays",
        "expectedRevision",
        "operationId",
      ]),
    "Issuer must have only the reviewed fields.",
  ),
  rule((input) => isPlainRecord(input.issuer), "Issuer block must be an object."),
  rule(
    (input) =>
      hasOnlyKeys(input.issuer, ["legalName", "billingEmail", "addressLines", "taxId", "footerNote"]),
    "Issuer block must have only the reviewed fields.",
  ),
  rule((input) => text(input.issuer.legalName, 200), "Issuer legal name must be 1 to 200 characters."),
  rule(
    (input) => typeof input.issuer.billingEmail === "string" && EMAIL_PATTERN.test(input.issuer.billingEmail),
    "Issuer billing email must be an email address.",
  ),
  rule(
    (input) =>
      Array.isArray(input.issuer.addressLines) &&
      input.issuer.addressLines.length >= 1 &&
      input.issuer.addressLines.length <= 6 &&
      input.issuer.addressLines.every((line: unknown) => text(line, 200)),
    "Issuer address must be 1 to 6 lines of 1 to 200 characters.",
  ),
  rule(
    (input) => optionalText(input.issuer.taxId, 64),
    "Issuer tax ID must be absent or 1 to 64 characters.",
  ),
  rule(
    (input) => optionalText(input.issuer.footerNote, 500),
    "Issuer footer note must be absent or 1 to 500 characters.",
  ),
  rule(
    (input) =>
      Array.isArray(input.paymentMethods) &&
      input.paymentMethods.length <= 8 &&
      input.paymentMethods.every(
        (method: any) =>
          isPlainRecord(method) &&
          hasOnlyKeys(method, ["label", "instructions", "offered"]) &&
          text(method.label, 60) &&
          text(method.instructions, 1000) &&
          onlyHttpsLinks(method.instructions) &&
          typeof method.offered === "boolean",
      ),
    "Payment methods must be up to 8 entries with a label, instructions (links must be https) and an offered flag.",
  ),
  rule(
    (input) =>
      Number.isSafeInteger(input.defaultNetTermsDays) &&
      input.defaultNetTermsDays >= 1 &&
      input.defaultNetTermsDays <= 365,
    "Default net terms must be a whole number of days from 1 to 365.",
  ),
];

export function issuerInput(input: unknown) {
  requireRules(input, issuerRules, refuse);
  const value = input as any;
  const block = value.issuer;
  const issuer: IssuerBlock = {
    legalName: block.legalName,
    billingEmail: block.billingEmail,
    addressLines: [...block.addressLines],
    ...(block.taxId !== undefined ? { taxId: block.taxId } : {}),
    ...(block.footerNote !== undefined ? { footerNote: block.footerNote } : {}),
  };
  const paymentMethods: AcceptedPaymentMethod[] = value.paymentMethods.map((method: any) => ({
    label: method.label,
    instructions: method.instructions,
    offered: method.offered,
  }));
  return {
    expectedRevision: requireExpectedRevision(value.expectedRevision),
    request: { issuer, paymentMethods, defaultNetTermsDays: value.defaultNetTermsDays as number },
  };
}

/**
 * The seller's details and accepted payment methods: admin-set data stored beside the other billing records and never
 * committed to this repository. Issuing an invoice copies them into the invoice, so changing them later never alters
 * an issued invoice or its PDF.
 */
export class BillingIssuer {
  constructor(
    private files: IdentityFiles,
    private grants: readonly OperatorGrant[],
    private now: () => string = () => new Date().toISOString(),
  ) {}
  async get(): Promise<IssuerRecord | null> {
    return (await this.files.get<IssuerRecord>(ISSUER_PATH))?.value ?? null;
  }
  async set(context: Context, input: unknown, operationId: string) {
    const actor = requireBillingAdministrator(context, this.grants);
    const operation = requireOperationId(operationId),
      { request, expectedRevision } = issuerInput(input);
    const { record, replayed } = await mutate<IssuerRecord>(this.files, {
      action: "issuer.set",
      recordKind: "issuer",
      path: ISSUER_PATH,
      operationId: operation,
      actor,
      request,
      expectedRevision,
      at: this.now(),
      apply: async () => ({ version: 1, kind: "billing-issuer", ...request }),
    });
    return { issuer: record, replayed };
  }
}

export const effectiveDefaultNetTerms = (issuer: Pick<IssuerRecord, "defaultNetTermsDays"> | null) =>
  issuer?.defaultNetTermsDays ?? DEFAULT_NET_TERMS_DAYS;
