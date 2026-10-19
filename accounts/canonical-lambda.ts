import { resolve } from "node:path";
import { canonicalAccountsHandler } from "./canonical-handler";
import { VirtuusS3IdentityFiles, VirtuusS3AccountFiles, type NativeTiming } from "./identity-files";
import type { RestEvent } from "./auth";
import { registrations } from "./registration";
import grants from "./operator-grants.json";
import reviewedPapyrusSites from "./papyrus-sites.json";
import { papyrusSiteRegistrations } from "./papyrus-sites";
import reviewedDeployment from "./deployment.json";
import { membershipLookupMode } from "./durable-accounts";
import { operatorGrants } from "./operator-policy";
import { CognitoKeys } from "./auth";
if (process.env.PROSPECTUS_CANONICAL_ACCOUNTS !== "enabled")
  throw new Error("Canonical accounts runtime not enabled.");
const bucket = process.env.PROSPECTUS_ACCOUNTS_BUCKET ?? "",
  owner = process.env.PROSPECTUS_ACCOUNTS_OWNER ?? "";
const config = {
  enabled: true as const,
  bucket,
  region: "us-east-1" as const,
  expectedOwner: owner,
  tenant: "prospectus-central",
};
const executable = resolve(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), "identity-files");
const keys = new CognitoKeys();
const products = registrations([
    ...JSON.parse(process.env.PROSPECTUS_PRODUCTS ?? "[]"),
    ...papyrusSiteRegistrations(reviewedPapyrusSites),
  ]),
  reviewedGrants = operatorGrants(grants),
  membershipLookup = membershipLookupMode(
    (reviewedDeployment as { membershipLookup?: unknown }).membershipLookup,
  );
let activeRequestId = "unavailable";
const timingForProject = (project: "identities" | "accounts") => (value: NativeTiming) =>
  console.info(JSON.stringify({ event: "accounts.native", requestId: activeRequestId, project, ...value }));
let warmIdentities: VirtuusS3IdentityFiles | undefined;
let warmAccounts: VirtuusS3AccountFiles | undefined;
const closeWarmBridges = () => {
  warmIdentities?.close();
  warmAccounts?.close();
};
const warmBridges = () => {
  if (!warmIdentities || warmIdentities.isClosed)
    warmIdentities = new VirtuusS3IdentityFiles(
      { ...config, project: "identities" },
      executable,
      true,
      timingForProject("identities"),
    );
  if (!warmAccounts || warmAccounts.isClosed)
    warmAccounts = new VirtuusS3AccountFiles(config, executable, true, timingForProject("accounts"));
  return { identities: warmIdentities, accounts: warmAccounts };
};
process.once("SIGTERM", closeWarmBridges);
export const handler = async (
  event: RestEvent,
  context?: { awsRequestId?: string; getRemainingTimeInMillis?: () => number },
) => {
  activeRequestId = /^[a-f0-9-]{36}$/i.test(context?.awsRequestId ?? "")
    ? context!.awsRequestId!
    : "unavailable";
  const { identities, accounts } = warmBridges();
  const remaining = context?.getRemainingTimeInMillis?.();
  const deadline =
    remaining === undefined ? undefined : setTimeout(closeWarmBridges, Math.max(1, remaining - 250));
  deadline?.unref();
  try {
    return await canonicalAccountsHandler(
      identities,
      accounts,
      products,
      (issuer, kid) => keys.resolve(issuer, kid),
      () => Date.now() / 1000,
      reviewedGrants,
      membershipLookup,
    )(event);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
};
