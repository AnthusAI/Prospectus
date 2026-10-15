import { defineBackend } from "@aws-amplify/backend";
import { Code, CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnRole, CfnPolicy } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Stack, Token, RemovalPolicy } from "aws-cdk-lib";
import type {AccountsPlaneOptions} from "../infra/lib/accounts-plane";
import { ProspectusBackend } from "../infra/lib/prospectus-backend";
import { TARGET_ACCOUNT, TARGET_REGION, AMPLIFY_APP_ID, DEPLOYMENT_BRANCH, SOURCE_REPOSITORY, SITE_DOMAIN, assertDeploymentScope } from "../infra/lib/scope";
export function createProspectusBackend(code: (stack: Stack) => Code, evaluationCode?: (stack: Stack) => Code, accounts?: AccountsPlaneOptions) {
  const context = JSON.parse(process.env.CDK_CONTEXT_JSON ?? "{}");
  if (context["amplify-backend-namespace"] !== AMPLIFY_APP_ID || context["amplify-backend-name"] !== DEPLOYMENT_BRANCH || context["amplify-backend-type"] !== "branch") throw new Error("Prospectus deployment must target its approved Amplify app main branch");
  // Let Amplify bind its normal CDK synthesizer and account bootstrap.
  const backend = defineBackend({});
  const stack = backend.createStack("prospectus");
  const environment = Stack.of(stack);
  const account = Token.isUnresolved(environment.account) ? process.env.CDK_DEFAULT_ACCOUNT : environment.account;
  const region = Token.isUnresolved(environment.region) ? (process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION) : environment.region;
  assertDeploymentScope({
    account: account ?? "", region: region ?? "", siteDomain: SITE_DOMAIN,
    repository: SOURCE_REPOSITORY, appId: context["amplify-backend-namespace"], branch: context["amplify-backend-name"],
  });
  // Name Amplify's two pinned-version branch helpers explicitly: generated physical
  // names may truncate stack prefixes and would invalidate scoped deployment IAM.
  const helperRoles = backend.stack.node.findAll().filter((node): node is CfnRole => node instanceof CfnRole && node.node.path.includes("/AmplifyBranchLinker/"));
  const helperFunctions = backend.stack.node.findAll().filter((node): node is CfnFunction => node instanceof CfnFunction && node.node.path.includes("/AmplifyBranchLinker/"));
  if (helperRoles.length !== 2 || helperFunctions.length !== 2) throw new Error("Amplify branch helper resources changed; review deployment IAM before upgrading");
  const logs = new Map<string, LogGroup>();
  for (const suffix of ["linker", "provider"]) {
    logs.set(suffix, new LogGroup(backend.stack, `BranchHelperLogs-${suffix}`, {
      logGroupName: `/aws/lambda/prospectus-${AMPLIFY_APP_ID}-${DEPLOYMENT_BRANCH}-${suffix}`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.RETAIN,
    }));
  }
  const suffixFor = (path: string) => path.includes("CustomResourceProvider") ? "provider" : "linker";
  for (const role of helperRoles) {
    const suffix = suffixFor(role.node.path);
    role.roleName = `prospectus-${AMPLIFY_APP_ID}-${DEPLOYMENT_BRANCH}-${suffix}`;
    role.managedPolicyArns = [];
    role.policies = [{ policyName: "ScopedLogs", policyDocument: {
      Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: logs.get(suffix)!.logGroupArn }],
    } }];
  }
  for (const fn of helperFunctions) {
    const suffix = suffixFor(fn.node.path);
    fn.functionName = `prospectus-${AMPLIFY_APP_ID}-${DEPLOYMENT_BRANCH}-${suffix}`;
    fn.loggingConfig = { logGroup: logs.get(suffix)!.logGroupName };
  }
  for (const node of backend.stack.node.findAll()) {
    if (!(node instanceof CfnPolicy) || !node.node.path.includes("/AmplifyBranchLinker/")) continue;
    const document = backend.stack.resolve(node.policyDocument);
    for (const statement of document.Statement ?? []) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      if (actions.includes("amplify:UpdateBranch")) statement.Resource = `arn:aws:amplify:${TARGET_REGION}:${TARGET_ACCOUNT}:apps/${AMPLIFY_APP_ID}/branches/${DEPLOYMENT_BRANCH}`;
    }
    node.policyDocument = document;
  }
  const resources = new ProspectusBackend(stack, "Prospectus", code(backend.stack), evaluationCode?.(backend.stack), accounts);
  backend.addOutput({ custom: resources.outputs });

  return backend;
}
