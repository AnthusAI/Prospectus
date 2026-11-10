import { getAccessToken } from "../auth";
import { BillingError, type BillingClient, type Invoice, type Payment, type BillingOverview } from "./types";

/**
 * The client for a deployment whose billing routes do not exist yet. It reports itself unavailable, so no page
 * calls it, and every method refuses without making a request.
 */
export const unavailableBilling: BillingClient = (() => {
  const refuse = () =>
    Promise.reject(new BillingError(503, "Billing is not available yet.", "billing_unavailable"));
  return {
    available: false,
    access: refuse,
    overview: refuse,
    account: refuse,
    invoice: refuse,
    invoicePdf: refuse,
    payment: refuse,
    revealContact: refuse,
    saveProfile: refuse,
    raiseInvoice: refuse,
    recordPayment: refuse,
    allocate: refuse,
    reversePayment: refuse,
    writeOff: refuse,
    voidInvoice: refuse,
    createEngagement: refuse,
    changeEngagement: refuse,
    issuer: refuse,
    saveIssuer: refuse,
  };
})();

/**
 * The operator billing routes under the account directory (`/v1/account-directory`). Those in docs/BILLING.md
 * are `billing-profile`, `billing-lines`, `invoices` and `payments` per account. Routes marked "proposed" are
 * what the pages also need and the document does not name yet. The server checks `accounts:admin:billing` on
 * every write whatever this client sends.
 *
 * Nothing here logs. It is only constructed once the routes exist (VITE_BILLING_ROUTES=1).
 */
export function billingBrowser(
  base: string | undefined,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  token: () => string | null = getAccessToken,
): BillingClient {
  const root = base?.replace(/\/$/, "");
  async function send(path: string, method = "GET", body?: unknown, accept = "application/json") {
    if (!root) throw new BillingError(503, "The Accounts service has not been configured.");
    const access = token();
    if (!access) throw new BillingError(401, "Sign in again to view billing.");
    const response = await fetcher(`${root}${path}`, {
      method,
      cache: "no-store",
      redirect: "error",
      headers: {
        authorization: `Bearer ${access}`,
        accept,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => null);
      throw new BillingError(
        response.status,
        typeof value?.message === "string"
          ? value.message
          : response.status === 403
            ? "You do not have access to billing."
            : response.status === 409
              ? "Someone changed this. Reload the latest record before saving again."
              : "Billing could not be loaded. Try again.",
        typeof value?.code === "string" ? value.code : undefined,
      );
    }
    return accept === "application/json" ? response.json() : response.blob();
  }
  const account = (id: string) => `/operator/accounts/${encodeURIComponent(id)}`;
  const part = encodeURIComponent;
  return {
    available: true,
    // proposed: the operator's reviewed permissions, so the console knows whether to show actions
    access: () => send("/operator/billing/access"),
    // proposed: cross-account listings, one request each
    overview: async (): Promise<BillingOverview> => {
      const [accounts, invoices, payments, engagements] = await Promise.all([
        send("/operator/billing/accounts"),
        send("/operator/billing/invoices"),
        send("/operator/billing/payments"),
        send("/operator/billing/engagements"),
      ]);
      return {
        accounts: accounts.accounts,
        invoices: invoices.invoices,
        payments: payments.payments,
        engagements: engagements.engagements,
      };
    },
    // billing-profile, billing-lines, invoices and payments are in docs/BILLING.md; billing-journal is proposed
    account: async (id) => {
      const [profile, lines, invoices, payments, journal, summary, engagements] = await Promise.all([
        send(`${account(id)}/billing-profile`),
        send(`${account(id)}/billing-lines`),
        send(`${account(id)}/invoices`),
        send(`${account(id)}/payments`),
        send(`${account(id)}/billing-journal`),
        send(`/operator/billing/accounts/${part(id)}`),
        send(`${account(id)}/engagements`),
      ]);
      return {
        account: summary.account,
        profile: profile.profile ?? null,
        lines: lines.lines,
        invoices: invoices.invoices,
        payments: payments.payments,
        journal: journal.events,
        engagements: engagements.engagements,
      };
    },
    // proposed: addressed by invoice number (or id for a draft) so the shareable path needs no account
    invoice: (reference) => send(`/operator/billing/invoices/${part(reference)}`),
    invoicePdf: (reference) =>
      send(`/operator/billing/invoices/${part(reference)}/pdf`, "GET", undefined, "application/pdf"),
    payment: (id) => send(`/operator/billing/payments/${part(id)}`),
    // proposed: an audited reveal, so the full contact is never in the page until asked for
    revealContact: async (id) =>
      (await send(`${account(id)}/billing-profile/reveal-contact`, "POST", {})).contact,
    // POST, not PUT: the accounts API and its BFF route only GET and POST, and central takes POST as the save.
    saveProfile: async (id, input) => (await send(`${account(id)}/billing-profile`, "POST", input)).profile,
    raiseInvoice: async (input): Promise<Invoice> =>
      (await send(`${account(input.accountId)}/invoices`, "POST", input)).invoice,
    recordPayment: async (input): Promise<Payment> =>
      (await send(`${account(input.accountId)}/payments`, "POST", input)).payment,
    allocate: async (id, input) =>
      (await send(`/operator/billing/payments/${part(id)}/allocations`, "POST", input)).payment,
    reversePayment: async (id, input) =>
      (await send(`/operator/billing/payments/${part(id)}/reversal`, "POST", input)).payment,
    writeOff: async (id, input) =>
      (await send(`/operator/billing/invoices/${part(id)}/write-off`, "POST", input)).invoice,
    voidInvoice: async (id, input) =>
      (await send(`/operator/billing/invoices/${part(id)}/void`, "POST", input)).invoice,
    createEngagement: async ({ accountId, ...input }) =>
      (await send(`${account(accountId)}/engagements`, "POST", input)).engagement,
    changeEngagement: async (id, input) =>
      (await send(`/operator/billing/engagements/${part(id)}`, "POST", input)).engagement,
    issuer: () => send("/operator/billing/issuer"),
    saveIssuer: (input) => send("/operator/billing/issuer", "POST", input),
  };
}
