import { resolve } from "node:path";
import { canonicalAccountsHandler } from "./canonical-handler";
import { VirtuusS3IdentityFiles, VirtuusS3AccountFiles, type NativeTiming } from "./identity-files";
import type { RestEvent } from "./auth";
import { registrations } from "./registration";
import grants from "./operator-grants.json";
import reviewedPapyrusSites from "./papyrus-sites.json";
import { papyrusSiteRegistrations } from "./papyrus-sites";
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
  reviewedGrants = operatorGrants(grants);
export const handler = async (
  event: RestEvent,
  context?: { awsRequestId?: string; getRemainingTimeInMillis?: () => number },
) => {
  const requestId = /^[a-f0-9-]{36}$/i.test(context?.awsRequestId ?? "")
    ? context!.awsRequestId
    : "unavailable";
  const timing = (project: "identities" | "accounts") => (value: NativeTiming) =>
    console.info(JSON.stringify({ event: "accounts.native", requestId, project, ...value }));
  const identities = new VirtuusS3IdentityFiles(
    { ...config, project: "identities" },
    executable,
    true,
    timing("identities"),
  );
  const accounts = new VirtuusS3AccountFiles(config, executable, true, timing("accounts"));
  const close = () => {
    identities.close();
    accounts.close();
  };
  const remaining = context?.getRemainingTimeInMillis?.();
  const deadline = remaining === undefined ? undefined : setTimeout(close, Math.max(1, remaining - 250));
  deadline?.unref();
  try {
    return await canonicalAccountsHandler(
      identities,
      accounts,
      products,
      (issuer, kid) => keys.resolve(issuer, kid),
      () => Date.now() / 1000,
      reviewedGrants,
    )(event);
  } finally {
    if (deadline) clearTimeout(deadline);
    close();
  }
};
