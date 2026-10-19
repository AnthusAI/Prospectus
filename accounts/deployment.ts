import { REVIEW_IDENTIFIER_PATTERN, matchesStringPattern } from "./validation-rules";
import { readFileSync } from "node:fs";
import { papyrusSiteRegistrations } from "./papyrus-sites";
import { membershipLookupMode } from "./durable-accounts";
import { loginChallengeSignerConfiguration } from "./challenge-signer";
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
  const loginChallengeSigner = loginChallengeSignerConfiguration(config.loginChallengeSigner);
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
  return {
    consoleClientEnabled: consoleConfig.clientEnabled,
    consolePairEnabled: consoleConfig.pairEnabled,
    consoleFederationReviewId: consoleConfig.federationReviewId as string,
    consolePairReviewId: consoleConfig.pairReviewId as string,
    googlePolicyReviewId: config.googlePolicyReviewId as string,
    loginChallengeSigner,
    papyrusSites: papyrusSiteRegistrations(
      JSON.parse(readFileSync(new URL("./papyrus-sites.json", import.meta.url), "utf8")),
    ),
  };
}
