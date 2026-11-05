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
