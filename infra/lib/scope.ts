export const TARGET_ACCOUNT = "682849160744";
export const TARGET_REGION = "us-east-1";
export const SITE_DOMAIN = "prospectus.cyclotron.anth.us";
export const PROJECT_NAMESPACE = "cyclotron/prospectus";
export const MEMBER_GROUP = "prospectus-members";
export const SOURCE_REPOSITORY = "AnthusAI/Prospectus";
export const AMPLIFY_APP_ID = "dnfou6dg4d6x2";
export const DEPLOYMENT_BRANCH = "proof";

export function assertDeploymentScope(scope: {
  account: string;
  region: string;
  siteDomain: string;
  repository: string;
  appId: string;
  branch: string;
}): void {
  const expected = {
    account: TARGET_ACCOUNT, region: TARGET_REGION,
    siteDomain: SITE_DOMAIN, repository: SOURCE_REPOSITORY,
    appId: AMPLIFY_APP_ID, branch: DEPLOYMENT_BRANCH,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (scope[key as keyof typeof scope] !== value) {
      throw new Error(`Prospectus ${key} must be ${value}; review a source change to change deployment scope.`);
    }
  }
}
