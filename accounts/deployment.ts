import { REVIEW_IDENTIFIER_PATTERN, matchesStringPattern } from "./validation-rules";
import { readFileSync } from "node:fs";
import { papyrusSiteRegistrations } from "./papyrus-sites";
import { reviewedLabVerifierEntry } from "./lab-verifier";
import { accountCreationLimits, membershipLookupMode } from "./durable-accounts";
import { loginChallengeSignerConfiguration } from "./challenge-signer";
import { babulusFromEnvironment } from "./babulus";
import { siteSubjectSecretConfiguration } from "./site-subjects";
import { rateTableConfiguration } from "../quota/rate-table";
import { billingDeployment } from "../billing/deployment";
import { GOOGLE_CLIENT_ID_PATTERN } from "./google-direct";
import { PORTAL_GOOGLE_CLIENT_ID } from "../infra/lib/scope";

export const ANTHUS_ONE_FEDERATION_REVIEW_ID = "anthus-one-google-direct-v1-20261020";

/** The Anthus One portal signs in with Google directly. Activation names the exact public client and reviewed policy. */
function anthusOneDeployment() {
  const config = JSON.parse(readFileSync(new URL("./anthus-one-deployment.json", import.meta.url), "utf8"));
  if (config.enabled === false) return undefined;
  if (
    config.enabled !== true ||
    config.googleClientId !== PORTAL_GOOGLE_CLIENT_ID ||
    !matchesStringPattern(config.googleClientId, GOOGLE_CLIENT_ID_PATTERN) ||
    config.federationReviewId !== ANTHUS_ONE_FEDERATION_REVIEW_ID
  )
    throw new Error("Anthus One activation requires the exact reviewed Google client and policy ID.");
  return {
    googleClientId: config.googleClientId as string,
    federationReviewId: config.federationReviewId as string,
  };
}
export function accountsDeployment() {
  const config = JSON.parse(readFileSync(new URL("./deployment.json", import.meta.url), "utf8"));
  if (config.enabled === false) return null;
  if (
    config.enabled !== true ||
    config.storageMode !== "canonical-virtuus-v1" ||
    !matchesStringPattern(config.googlePolicyReviewId, REVIEW_IDENTIFIER_PATTERN)
  )
    throw new Error("Canonical accounts activation requires reviewed storage and Google policy ID.");
  membershipLookupMode(config.membershipLookup);
  accountCreationLimits(config.accountCreationLimits);
  const loginChallengeSigner = loginChallengeSignerConfiguration(config.loginChallengeSigner);
  // Public-reader sites need it; without it they fail closed (503) and editor sites are unaffected.
  const siteSubjectSecret =
    config.siteSubjectSecret === undefined
      ? undefined
      : siteSubjectSecretConfiguration(config.siteSubjectSecret);
  // Creates the parameter with a refusing placeholder; the real table is written later, outside Git. Without it
  // every quota call is refused as unavailable.
  const quotaRateTable =
    config.quotaRateTable === undefined ? undefined : rateTableConfiguration(config.quotaRateTable);
  const consoleConfig = JSON.parse(
    readFileSync(new URL("./console-deployment.json", import.meta.url), "utf8"),
  );
  if (
    typeof consoleConfig.clientEnabled !== "boolean" ||
    typeof consoleConfig.pairEnabled !== "boolean" ||
    (consoleConfig.pairEnabled && !consoleConfig.clientEnabled) ||
    consoleConfig.federationReviewId !== "cyclotron-google-only-unlinked-v1-20261015" ||
    consoleConfig.pairReviewId !== "cyclotron-execution-pair-v1-20261015"
  )
    throw new Error("Console activation requires the exact reviewed client and principal pair.");
  // billing/deployment.json, committed disabled: true adds the billing storage prefixes and the ten write routes.
  const billingLedger = billingDeployment(
    JSON.parse(readFileSync(new URL("../billing/deployment.json", import.meta.url), "utf8")),
  ).ledgerEnabled;
  // docs/COST_ACCOUNTING.md: on since 2026-11-09 (Ryan). True creates the per-product usage queues and the drain schedule.
  if (config.usageQueues !== undefined && typeof config.usageQueues !== "boolean")
    throw new Error("usageQueues must be true or absent.");
  const usageQueues = config.usageQueues === true;
  // docs/COST_ACCOUNTING.md: on since 2026-11-09 (Ryan). True runs the daily Cost Explorer import through the management account.
  if (config.costImport !== undefined && typeof config.costImport !== "boolean")
    throw new Error("costImport must be true or absent.");
  const costImport = config.costImport === true;
  const babulus = babulusFromEnvironment();
  return {
    consoleClientEnabled: consoleConfig.clientEnabled,
    consolePairEnabled: consoleConfig.pairEnabled,
    consoleFederationReviewId: consoleConfig.federationReviewId as string,
    consolePairReviewId: consoleConfig.pairReviewId as string,
    anthusOne: anthusOneDeployment(),
    googlePolicyReviewId: config.googlePolicyReviewId as string,
    loginChallengeSigner,
    ...(siteSubjectSecret ? { siteSubjectSecret } : {}),
    ...(quotaRateTable ? { quotaRateTable } : {}),
    // Absent, not false, while the ledger is off, so nothing in the synthesized output can differ.
    ...(billingLedger ? { billingLedger } : {}),
    // Absent, not false, while off, so nothing in the synthesized output can differ.
    ...(usageQueues ? { usageQueues } : {}),
    ...(costImport ? { costImport } : {}),
    labVerifier: reviewedLabVerifierEntry(
      JSON.parse(readFileSync(new URL("./lab-verifier.json", import.meta.url), "utf8")),
    ),
    ...(babulus ? { babulus } : {}),
    papyrusSites: papyrusSiteRegistrations(
      JSON.parse(readFileSync(new URL("./papyrus-sites.json", import.meta.url), "utf8")),
    ),
  };
}
