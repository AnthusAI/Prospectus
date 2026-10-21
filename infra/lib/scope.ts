export const TARGET_ACCOUNT = "712236451410";
export const TARGET_REGION = "us-east-1";
export const SITE_DOMAIN = "prospectus.anth.us";
// Preserve canonical paths during the account move; this is a data namespace, not hosting ownership.
export const PROJECT_NAMESPACE = "cyclotron/prospectus";
export const MEMBER_GROUP = "prospectus-members";
// Kanbus multi-board grant group: kanbus:<tenant>/<project> (Kanbus#502).
export const KANBUS_BOARD_GROUP = `kanbus:${PROJECT_NAMESPACE}`;
export const SOURCE_REPOSITORY = "AnthusAI/Prospectus";
export const AMPLIFY_APP_ID = "d15sc1sptohtqb";
export const DEPLOYMENT_BRANCH = "main";
export const PRODUCTION_ORIGIN = `https://${SITE_DOMAIN}`;
/**
 * `npm run dev:cloud` serves this branch's frontend here, signed in through the deployed Cognito
 * client and calling the deployed API. Cognito permits plain http only for localhost.
 */
export const LOCAL_DEV_ORIGIN = "http://localhost:5417";
/** The Anthus One customer portal: a separate application that shares only the account service. */
export const PORTAL_DOMAIN = "one.anth.us";
export const PORTAL_ORIGIN = `https://${PORTAL_DOMAIN}`;
/** `npm run dev:portal` serves the portal here against the deployed backend. */
export const PORTAL_DEV_ORIGIN = "http://localhost:5421";
/** Browser origins allowed to sign in to the CRM and call its API. The portal's origins are not here: it has its own
 * Google sign-in and its own accounts API.
 */
export const APP_ORIGINS = [PRODUCTION_ORIGIN, LOCAL_DEV_ORIGIN] as const;
/** Browser origins allowed to call the Anthus One portal's accounts API (and the Google "Authorized JavaScript origins"). */
export const PORTAL_ORIGINS = [PORTAL_ORIGIN] as const;
/** The Anthus One Google OAuth client. A public identifier, used as the Google ID token audience; its secret is not used. */
export const PORTAL_GOOGLE_CLIENT_ID =
  "712526614578-dp3o0ofrukf7h2qcjst345t033mi990c.apps.googleusercontent.com";

export function assertDeploymentScope(scope: {
  account: string;
  region: string;
  siteDomain: string;
  repository: string;
  appId: string;
  branch: string;
}): void {
  const expected = {
    account: TARGET_ACCOUNT,
    region: TARGET_REGION,
    siteDomain: SITE_DOMAIN,
    repository: SOURCE_REPOSITORY,
    appId: AMPLIFY_APP_ID,
    branch: DEPLOYMENT_BRANCH,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (scope[key as keyof typeof scope] !== value) {
      throw new Error(
        `Prospectus ${key} must be ${value}; review a source change to change deployment scope.`,
      );
    }
  }
}
