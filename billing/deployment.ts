export interface BillingDeployment {
  /** The operator billing routes (invoices, payments, issuer). Off until storage, role and grant are approved. */
  ledgerEnabled: boolean;
}

/**
 * `billing/deployment.json`, committed disabled and imported by the Lambda entry point. The ledger routes answer 404 and no billing storage is opened until
 * a reviewed change sets `ledger.enabled` to true. Anything but the exact reviewed shape stops the service.
 */
export function billingDeployment(config: unknown): BillingDeployment {
  const value = config as { ledger?: { enabled?: unknown } };
  if (
    !config ||
    typeof config !== "object" ||
    Object.keys(config).join(",") !== "ledger" ||
    !value.ledger ||
    typeof value.ledger !== "object" ||
    Object.keys(value.ledger).join(",") !== "enabled" ||
    typeof value.ledger.enabled !== "boolean"
  )
    throw new Error("Billing deployment must be exactly { ledger: { enabled: boolean } }.");
  return { ledgerEnabled: value.ledger.enabled };
}

/**
 * What the console build is told about billing: the same reviewed flag that turns the backend routes on. With the
 * flag off the build replaces `import.meta.env.VITE_BILLING_ROUTES` with `undefined`, whatever the environment says,
 * so the console behaves as it did before billing existed; with it on, the console calls the routes.
 */
export const consoleBillingDefine = (deployment: BillingDeployment) => ({
  "import.meta.env.VITE_BILLING_ROUTES": deployment.ledgerEnabled ? '"1"' : "undefined",
});
