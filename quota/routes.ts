/** The API Gateway method-and-path patterns a quota-registered product role may invoke, and nothing else. */
export const quotaRoutes = [
  "POST/v1/quota/accounts/*/reservations",
  "POST/v1/quota/accounts/*/reservations/*/settle",
  "POST/v1/quota/accounts/*/reservations/*/release",
  "POST/v1/quota/accounts/*/usage",
  "POST/v1/quota/accounts/*/check",
] as const;
