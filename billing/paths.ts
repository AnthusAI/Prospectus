/**
 * The operator billing paths, in one dependency-free module so the central service, the staff BFF and the tests all
 * agree on exactly which paths exist. `/v1/account-directory/operator/...` is the central side; the BFF serves the same
 * tails under `/api/saas/operator/...`.
 */
export const OPERATOR_PREFIX = "/v1/account-directory/operator";
const ID = "[a-f0-9-]{36}";
const OPERATOR_TAIL = [
  "billing(/.*)?",
  `accounts/${ID}/(billing-profile|billing-lines|invoices|payments|billing-journal)(/.*)?`,
];
const CENTRAL = OPERATOR_TAIL.map((tail) => new RegExp(`^${OPERATOR_PREFIX}/${tail}$`));

/** Every central path the billing module serves. When billing is off the directory answers 404 for exactly these. */
export const isBillingPath = (path: string) => CENTRAL.some((pattern) => pattern.test(path));

const BFF_PREFIX = "/api/saas/operator/";
/** The central path for a staff BFF path, or null when the BFF does not forward it. Query strings are never forwarded. */
export function centralBillingPath(bffPath: string): string | null {
  if (!bffPath.startsWith(BFF_PREFIX)) return null;
  const central = `${OPERATOR_PREFIX}/${bffPath.slice(BFF_PREFIX.length)}`;
  return isBillingPath(central) ? central : null;
}

/** Largest invoice PDF carried through. A Lambda response is capped at 6 MB and base64 adds a third, so this stays under. */
export const MAXIMUM_PDF_BYTES = 4_000_000;
/** Billing request bodies: an invoice of 50 line items is about 20 KB. */
export const BILLING_MAXIMUM_BODY_BYTES = 40_000;

/**
 * The ten operator write routes the staff BFF role may invoke once the ledger is on, as [method, path] for the API
 * Gateway execute-api ARNs. Reads need nothing new: `GET /v1/account-directory/*` is already granted. Central still
 * requires `accounts:admin:billing` for every one of these.
 */
export const billingWriteRoutes: ReadonlyArray<readonly [string, string]> = [
  ["POST", `${OPERATOR_PREFIX}/accounts/*/invoices`],
  ["POST", `${OPERATOR_PREFIX}/accounts/*/payments`],
  ["POST", `${OPERATOR_PREFIX}/accounts/*/billing-profile`],
  ["POST", `${OPERATOR_PREFIX}/accounts/*/billing-profile/reveal-contact`],
  ["POST", `${OPERATOR_PREFIX}/billing/payments/*/allocations`],
  ["POST", `${OPERATOR_PREFIX}/billing/payments/*/reversal`],
  ["POST", `${OPERATOR_PREFIX}/billing/invoices/*/void`],
  ["POST", `${OPERATOR_PREFIX}/billing/invoices/*/write-off`],
  ["POST", `${OPERATOR_PREFIX}/billing/invoices/*/credit`],
  ["POST", `${OPERATOR_PREFIX}/billing/issuer`],
];
/** The S3 prefixes billing storage uses, added to the central runtime role only when the ledger is on. */
export const billingStoragePrefixes = [
  "prospectus-central/billing/*",
  "_virtuus/prospectus-central/billing/*",
] as const;
