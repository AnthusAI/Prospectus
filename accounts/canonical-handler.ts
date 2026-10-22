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
  const directoryHandler = accountDirectoryHandler(service, products, keys, nowSeconds, reviewedGrants);
  const routed = (event: RestEvent) =>
    event.path.startsWith("/v1/account-directory")
      ? directoryHandler(event)
      : event.path.startsWith("/v1/accounts") || event.path === "/v1/identities/resolve"
        ? accounts(event)
        : identity(event);
  // Public-reader sites pass through one gate that replaces Person IDs with pairwise site subjects; it fails closed
  // without the site subject secret. Every other caller is routed exactly as before.
  const retired = siteSubjectSecret
    ? new RetiredSiteSubjects(identityFiles, products, siteSubjectSecret, nowSeconds)
    : undefined;
  return publicReaderHandler(routed, products, siteSubjectSecret, retired, nowSeconds);
}
