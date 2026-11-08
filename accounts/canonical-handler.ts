import type { IdentityFiles } from "./identity-files";
import type { KeyResolver, RestEvent } from "./auth";
import type { ValidatedRegistrations } from "./registration";
import { DurableGoogleIdentities } from "./durable-google-identities";
import {
  DurableAccountsService,
  type AccountCreationLimits,
  type MembershipLookup,
} from "./durable-accounts";
import { googlePersonDirectory } from "./person-directory";
import { googleIdentityHandler } from "./google-identity";
import { accountDirectoryHandler } from "./directory-handler";
import { operatorGrants, type OperatorGrant } from "./operator-policy";
import { accountHandler } from "./handler";
import type { ChallengeSigner } from "./challenge-signer";
import { publicReaderHandler, type SiteSubjectSecret } from "./site-subjects";
import { RetiredSiteSubjects } from "./retired-site-subjects";
import { Quota } from "../quota/service";
import { unconfiguredRateTable, type RateTableSource } from "../quota/rate-table";
import { quotaHandler } from "../quota/handler";
import { CostLedger } from "../quota/costs";
import { drainUsage, type UsageQueueClient } from "../quota/usage-drain";
import { BillingIssuer } from "../billing/issuer";
import { BillingLedger } from "../billing/ledger";
import { BillingLines } from "../billing/lines";
import { reviewedBillingPlans } from "../billing/plans";
import { BillingProfiles } from "../billing/profile";
import { billingOperatorRoutes } from "../billing/routes";
/** Trusted runtime composition, intentionally no AWS configuration, resource
 * provisioning. Deployment bootstrap is separate. File adapters/namespaces are server-owned.
 */
export function canonicalAccountsHandler(
  identityFiles: IdentityFiles,
  accountFiles: IdentityFiles,
  products: ValidatedRegistrations,
  keys: KeyResolver,
  nowSeconds = () => Date.now() / 1000,
  grants: readonly OperatorGrant[] = [],
  membershipLookup: MembershipLookup = "scan",
  challengeSigner?: ChallengeSigner,
  creationLimits: AccountCreationLimits = {},
  siteSubjectSecret?: SiteSubjectSecret,
  quotaFiles?: IdentityFiles,
  quotaRateTable?: RateTableSource,
  /** Billing storage. Absent unless billing/deployment.json enables the ledger: billing routes then answer 404. */
  billingFiles?: IdentityFiles,
  /** Per-product usage queues (docs/COST_ACCOUNTING.md). Absent unless the deployment enables them: the scheduled
   * drain task then does nothing. */
  usageDrain?: {
    client: UsageQueueClient;
    queues: Readonly<Record<string, string>>;
    hasTime?: () => boolean;
  },
) {
  const reviewedGrants = operatorGrants(grants);
  const repository = new DurableGoogleIdentities(identityFiles),
    directory = googlePersonDirectory(repository, products);
  const identity = googleIdentityHandler(repository, products, keys, nowSeconds, challengeSigner);
  const service = new DurableAccountsService(
    accountFiles,
    directory,
    () => new Date(nowSeconds() * 1000).toISOString(),
    membershipLookup,
    creationLimits,
  );
  const accounts = accountHandler(service, products, keys, nowSeconds);
  // Without quota storage the quota routes answer 503 and the directory shows quota as unavailable: never as zero.
  const quota =
    quotaFiles &&
    new Quota(
      quotaFiles,
      async (accountId) => {
        const document = (await service.read(accountId))?.value;
        return document ? { entitlements: document.entitlements } : null;
      },
      reviewedGrants,
      () => new Date(nowSeconds() * 1000).toISOString(),
      quotaRateTable ?? unconfiguredRateTable,
    );
  const quotaRoutes = quotaHandler(quota, products);
  const clock = () => new Date(nowSeconds() * 1000).toISOString();
  const billing =
    billingFiles &&
    billingOperatorRoutes({
      ledger: new BillingLedger(billingFiles, reviewedGrants, clock),
      profiles: new BillingProfiles(billingFiles, reviewedGrants, clock),
      // Read-only use: entitlements are consulted only when a line is created, and no line route is served yet.
      lines: new BillingLines(
        billingFiles,
        reviewedGrants,
        reviewedBillingPlans(),
        {
          entitlements: async (accountId) =>
            Object.fromEntries(
              Object.values((await service.read(accountId))?.value.entitlements ?? {}).map((entitlement) => [
                entitlement.product,
                entitlement.status,
              ]),
            ),
          isPublicReader: () => false,
        },
        clock,
      ),
      issuer: new BillingIssuer(billingFiles, reviewedGrants, clock),
      plans: reviewedBillingPlans(),
      grants: reviewedGrants,
      accounts: {
        all: async () => (await service.allAccounts()).map((document) => document.account),
        get: async (accountId) => (await service.read(accountId))?.value.account ?? null,
      },
      files: billingFiles,
      now: clock,
    });
  const directoryHandler = accountDirectoryHandler(
    service,
    products,
    keys,
    nowSeconds,
    reviewedGrants,
    quota,
    billing,
  );
  const routed = (event: RestEvent) =>
    event.path.startsWith("/v1/quota/")
      ? quotaRoutes(event)
      : event.path.startsWith("/v1/account-directory")
        ? directoryHandler(event)
        : event.path.startsWith("/v1/accounts") || event.path === "/v1/identities/resolve"
          ? accounts(event)
          : identity(event);
  // Public-reader sites pass through one gate that replaces Person IDs with pairwise site subjects; it fails closed
  // without the site subject secret. Every other caller is routed exactly as before.
  const retired = siteSubjectSecret
    ? new RetiredSiteSubjects(identityFiles, products, siteSubjectSecret, nowSeconds)
    : undefined;
  const http = publicReaderHandler(routed, products, siteSubjectSecret, retired, nowSeconds);
  const ledger =
    quota && quotaFiles && usageDrain
      ? new CostLedger(
          quotaFiles,
          async (accountId) => {
            const document = (await service.read(accountId))?.value;
            return document ? { entitlements: document.entitlements } : null;
          },
          quota,
          quotaRateTable ?? unconfiguredRateTable,
          clock,
        )
      : undefined;
  // The scheduled usage drain (docs/COST_ACCOUNTING.md). Without the queues it does nothing.
  const drain = async () => {
    if (!ledger || !usageDrain) return { drained: false, recorded: 0, refused: 0, deferred: 0 };
    const counts = await drainUsage({
      client: usageDrain.client,
      queues: usageDrain.queues,
      ledger,
      hasTime: usageDrain.hasTime,
      log: (entry) => console.info(JSON.stringify(entry)),
    });
    return { drained: true, ...counts };
  };
  return Object.assign(http, { drainUsage: drain });
}
