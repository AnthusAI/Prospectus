/**
 * The shareable addresses of the billing pages. Patterns are strict so a path can safely be a sign-in return target.
 * The Usage and billing list itself is the page path `/billing` (src/deep-links.ts).
 */
export type BillingRoute =
  | { kind: "invoice"; reference: string }
  | { kind: "new-invoice" }
  | { kind: "payment"; id: string }
  | { kind: "new-payment" }
  | { kind: "account-billing"; accountId: string }
  | { kind: "settings" };

const UUID = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";
const INVOICE_PATH = new RegExp(`^/invoices/(new|\\d{6}-\\d{3}|${UUID})/?$`);
const PAYMENT_PATH = new RegExp(`^/payments/(new|${UUID})/?$`);
const ACCOUNT_BILLING_PATH = /^\/accounts\/([A-Za-z0-9_-]{1,100})\/billing\/?$/;
const SETTINGS_PATH = /^\/settings\/billing\/?$/;

export function billingRouteFromPath(pathname: string): BillingRoute | null {
  const invoice = INVOICE_PATH.exec(pathname)?.[1];
  if (invoice) return invoice === "new" ? { kind: "new-invoice" } : { kind: "invoice", reference: invoice };
  const payment = PAYMENT_PATH.exec(pathname)?.[1];
  if (payment) return payment === "new" ? { kind: "new-payment" } : { kind: "payment", id: payment };
  const account = ACCOUNT_BILLING_PATH.exec(pathname)?.[1];
  if (account) return { kind: "account-billing", accountId: account };
  return SETTINGS_PATH.test(pathname) ? { kind: "settings" } : null;
}

const withAccount = (path: string, accountId?: string | null) =>
  accountId ? `${path}?account=${encodeURIComponent(accountId)}` : path;

export const billingHref = {
  invoice: (reference: string) => `/invoices/${encodeURIComponent(reference)}`,
  newInvoice: (accountId?: string | null) => withAccount("/invoices/new", accountId),
  payment: (id: string) => `/payments/${encodeURIComponent(id)}`,
  newPayment: (accountId?: string | null) => withAccount("/payments/new", accountId),
  accountBilling: (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/billing`,
  settings: () => "/settings/billing",
};

/** Where a needs-attention item leads. */
export function attentionHref(target: {
  type: "invoice" | "payment" | "account" | "new-invoice";
  id: string;
}) {
  if (target.type === "invoice") return billingHref.invoice(target.id);
  if (target.type === "payment") return billingHref.payment(target.id);
  if (target.type === "new-invoice") return billingHref.newInvoice(target.id);
  return billingHref.accountBilling(target.id);
}
