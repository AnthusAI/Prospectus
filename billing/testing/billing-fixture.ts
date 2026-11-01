import { randomUUID } from "node:crypto";
import type { IdentityFiles } from "../../accounts/identity-files";
import { roleOperations, type Context } from "../../accounts/model";
import { operatorSubjectHash, type OperatorGrant } from "../../accounts/operator-policy";
import { BillingLines } from "../lines";
import { BillingProfiles } from "../profile";
import { reviewedBillingPlans } from "../plans";
import { MemoryBillingFiles } from "./memory-billing-files";

export const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticOps";
export const OPERATOR_PRODUCT = "prospectus-crm";
export const FIXED_NOW = "2030-03-17T17:46:40.000Z";
/** Every synthetic contact field carries this marker, so a test can prove none of it reaches errors or logs. */
export const CONTACT_MARKER = "zz-contact-marker";

export const operator = (subject: string): Context => ({
  product: OPERATOR_PRODUCT,
  principal: "synthetic-operator-runtime",
  human: { issuer: ISSUER, subject },
  capabilities: [],
});
export const owner: Context = {
  product: "anthus-one",
  principal: "synthetic-portal-runtime",
  human: { issuer: ISSUER, subject: "owner" },
  capabilities: [...roleOperations.owner],
};
const grant = (subject: string, permission: OperatorGrant["permission"]): OperatorGrant => ({
  product: OPERATOR_PRODUCT,
  issuer: ISSUER,
  subjectHash: operatorSubjectHash(subject),
  permission,
  reviewedGrantId: `synthetic-${subject}-${permission.split(":").pop()}`,
});
export const grants: readonly OperatorGrant[] = [
  grant("ada", "accounts:admin:billing"),
  grant("ada", "accounts:admin:read"),
  grant("grace", "accounts:admin:billing"),
  grant("reader", "accounts:admin:read"),
];
export const contact = () => ({
  name: `Example Ledger Co ${CONTACT_MARKER}`,
  email: `billing-${CONTACT_MARKER}@example.invalid`,
  address: {
    line1: `1 Example Way ${CONTACT_MARKER}`,
    city: `Example ${CONTACT_MARKER}`,
    postalCode: `00000-${CONTACT_MARKER}`,
    country: "US",
  },
  taxId: `TAX-${CONTACT_MARKER}`,
});
export const profileInput = (overrides: Record<string, unknown> = {}) => ({
  mode: "invoiced",
  currency: "usd",
  billingContact: contact(),
  ...overrides,
});

export function billingFixture(storage?: IdentityFiles) {
  const files = new MemoryBillingFiles();
  const store = storage ?? files;
  const accountId = randomUUID();
  const entitlements: Record<string, Record<string, "active" | "disabled">> = {
    [accountId]: {
      "papyrus-example-invalid": "active",
      "papyrus-second-invalid": "active",
      "papyrus-reader-invalid": "active",
      cyclotron: "active",
    },
  };
  const entitlementReads: string[] = [];
  const ports = {
    entitlements: async (id: string) => {
      entitlementReads.push(id);
      return structuredClone(entitlements[id] ?? {});
    },
    isPublicReader: (product: string) => product === "papyrus-reader-invalid",
  };
  const profiles = new BillingProfiles(store, grants, () => FIXED_NOW);
  const lines = new BillingLines(store, grants, reviewedBillingPlans(), ports, () => FIXED_NOW);
  return { files, store, accountId, entitlements, entitlementReads, ports, profiles, lines };
}
