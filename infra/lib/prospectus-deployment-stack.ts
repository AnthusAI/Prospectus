import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { TARGET_ACCOUNT, TARGET_REGION, AMPLIFY_APP_ID, DEPLOYMENT_BRANCH } from "./scope";

/** Isolated file-only CDK bootstrap and Amplify service identity. Review only. */
export class ProspectusDeploymentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    const appId = new cdk.CfnParameter(this, "AmplifyAppId", { type: "String", default: AMPLIFY_APP_ID, allowedPattern: AMPLIFY_APP_ID, description: "Exact separately approved Prospectus Amplify app ID" }).valueAsString;
    const branch = new cdk.CfnParameter(this, "DeploymentBranch", { type: "String", default: DEPLOYMENT_BRANCH, allowedPattern: DEPLOYMENT_BRANCH }).valueAsString;
    const arn = (service: string, resource: string) => `arn:aws:${service}:${TARGET_REGION}:${TARGET_ACCOUNT}:${resource}`;
    const stackPattern = arn("cloudformation", `stack/amplify-${appId}-${branch}-*/*`);
    const helperRoles = ["linker", "provider"].map(suffix => `arn:aws:iam::${TARGET_ACCOUNT}:role/prospectus-${appId}-${branch}-${suffix}`);
    const helperFunctions = ["linker", "provider"].map(suffix => arn("lambda", `function:prospectus-${appId}-${branch}-${suffix}`));
    const bucket = new s3.Bucket(this, "Artifacts", {
      bucketName: `cdk-prspctus-assets-${TARGET_ACCOUNT}-${TARGET_REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true, removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    new ssm.StringParameter(this, "Version", { parameterName: "/cdk-bootstrap/prspctus/version", stringValue: "8" });
    const service = new iam.Role(this, "AmplifyService", {
      roleName: "ProspectusAmplifyService",
      assumedBy: new iam.ServicePrincipal("amplify.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": TARGET_ACCOUNT }, ArnEquals: { "aws:SourceArn": arn("amplify", `apps/${appId}`) } },
      }),
    });
    const trust = () => new iam.AccountPrincipal(TARGET_ACCOUNT).withConditions({ StringEquals: { "aws:PrincipalArn": service.roleArn } });
    const files = new iam.Role(this, "FilePublisher", { roleName: `cdk-prspctus-file-publishing-role-${TARGET_ACCOUNT}-${TARGET_REGION}`, assumedBy: trust() });
    files.addToPolicy(new iam.PolicyStatement({ actions: ["s3:GetBucketLocation", "s3:ListBucket"], resources: [bucket.bucketArn] }));
    files.addToPolicy(new iam.PolicyStatement({ actions: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"], resources: [bucket.arnForObjects("*")] }));
    const execution = new iam.Role(this, "CloudFormationExecution", {
      roleName: `cdk-prspctus-cfn-exec-role-${TARGET_ACCOUNT}-${TARGET_REGION}`,
      assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
    });
    const allow = (actions: string[], resources: string[]) => execution.addToPolicy(new iam.PolicyStatement({ actions, resources }));
    allow(["secretsmanager:GetSecretValue"], [arn("secretsmanager", "secret:prospectus/proof/oauth/google-??????")]);
    allow(["s3:GetObject", "s3:GetObjectVersion"], [bucket.arnForObjects("*")]);
    const canonical = `arn:aws:s3:::prospectus-cyclotron-records-${TARGET_ACCOUNT}`;
    allow(["s3:CreateBucket", "s3:DeleteBucket", "s3:GetBucket*", "s3:ListBucket", "s3:PutBucket*", "s3:PutEncryptionConfiguration", "s3:GetEncryptionConfiguration", "s3:DeleteBucketPolicy"], [canonical]);
    allow(["dynamodb:CreateTable", "dynamodb:DeleteTable", "dynamodb:UpdateTable", "dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:UpdateContinuousBackups", "dynamodb:ListTagsOfResource", "dynamodb:TagResource", "dynamodb:UntagResource"], [arn("dynamodb", "table/prospectus-cyclotron-catalog")]);
    execution.addToPolicy(new iam.PolicyStatement({ actions: ["cognito-idp:CreateUserPool", "cognito-idp:DescribeUserPoolDomain"], resources: ["*"], conditions: { StringEquals: { "aws:RequestedRegion": TARGET_REGION } } }));
    allow(["cognito-idp:DescribeUserPool", "cognito-idp:UpdateUserPool", "cognito-idp:DeleteUserPool", "cognito-idp:SetUserPoolMfaConfig", "cognito-idp:GetUserPoolMfaConfig", "cognito-idp:CreateUserPoolClient", "cognito-idp:DescribeUserPoolClient", "cognito-idp:UpdateUserPoolClient", "cognito-idp:DeleteUserPoolClient", "cognito-idp:CreateUserPoolDomain", "cognito-idp:UpdateUserPoolDomain", "cognito-idp:DeleteUserPoolDomain", "cognito-idp:CreateIdentityProvider", "cognito-idp:DescribeIdentityProvider", "cognito-idp:UpdateIdentityProvider", "cognito-idp:DeleteIdentityProvider", "cognito-idp:CreateGroup", "cognito-idp:GetGroup", "cognito-idp:UpdateGroup", "cognito-idp:DeleteGroup", "cognito-idp:TagResource", "cognito-idp:UntagResource", "cognito-idp:ListTagsForResource"], [arn("cognito-idp", "userpool/*")]);
    allow(["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE"], [`arn:aws:apigateway:${TARGET_REGION}::/apis`, `arn:aws:apigateway:${TARGET_REGION}::/apis/*`]);
    allow(["lambda:CreateFunction", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:DeleteFunction", "lambda:AddPermission", "lambda:RemovePermission", "lambda:GetPolicy", "lambda:TagResource", "lambda:UntagResource", "lambda:ListTags"], [arn("lambda", "function:prospectus-cyclotron-api"), arn("lambda", "function:prospectus-cyclotron-google-admission"), ...helperFunctions]);
    allow(["lambda:InvokeFunction"], helperFunctions);
    const roles = [`arn:aws:iam::${TARGET_ACCOUNT}:role/prospectus-cyclotron-runtime`, `arn:aws:iam::${TARGET_ACCOUNT}:role/prospectus-cyclotron-google-admission`, ...helperRoles];
    allow(["iam:CreateRole", "iam:GetRole", "iam:DeleteRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UntagRole"], roles);
    execution.addToPolicy(new iam.PolicyStatement({ actions: ["iam:PassRole"], resources: roles, conditions: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } } }));
    allow(["logs:DescribeLogGroups"], ["*"]);
    allow(["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy", "logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource"], [arn("logs", "log-group:/aws/lambda/prospectus-cyclotron-api:*"), arn("logs", "log-group:/aws/lambda/prospectus-cyclotron-google-admission:*"), ...(["linker", "provider"].map(suffix => arn("logs", `log-group:/aws/lambda/prospectus-${appId}-${branch}-${suffix}:*`)))]);
    allow(["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:DeleteStack", "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:GetTemplate", "cloudformation:ListStackResources", "cloudformation:DescribeStackResources"], [stackPattern]);
    const deploy = new iam.Role(this, "Deploy", { roleName: `cdk-prspctus-deploy-role-${TARGET_ACCOUNT}-${TARGET_REGION}`, assumedBy: trust() });
    deploy.addToPolicy(new iam.PolicyStatement({ actions: ["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:DeleteStack", "cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:DeleteChangeSet", "cloudformation:ExecuteChangeSet", "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:GetTemplate", "cloudformation:ListStackResources", "cloudformation:DescribeStackResources", "cloudformation:UpdateTerminationProtection"], resources: [stackPattern] }));
    deploy.addToPolicy(new iam.PolicyStatement({ actions: ["cloudformation:ValidateTemplate", "cloudformation:GetTemplateSummary"], resources: ["*"], conditions: { StringEquals: { "aws:RequestedRegion": TARGET_REGION } } }));
    deploy.addToPolicy(new iam.PolicyStatement({ actions: ["iam:PassRole"], resources: [execution.roleArn], conditions: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } } }));
    deploy.addToPolicy(new iam.PolicyStatement({ actions: ["s3:GetObject", "s3:GetObjectVersion"], resources: [bucket.arnForObjects("*")] }));
    const lookup = new iam.Role(this, "Lookup", { roleName: `cdk-prspctus-lookup-role-${TARGET_ACCOUNT}-${TARGET_REGION}`, assumedBy: trust() });
    for (const role of [deploy, lookup, service]) {
      role.addToPolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter", "ssm:GetParameters"], resources: [arn("ssm", "parameter/cdk-bootstrap/prspctus/version")] }));
      role.addToPolicy(new iam.PolicyStatement({ actions: ["cloudformation:DescribeStacks", "cloudformation:DescribeStackResources", "cloudformation:ListStackResources", "cloudformation:GetTemplate"], resources: [stackPattern] }));
    }
    service.addToPolicy(new iam.PolicyStatement({ actions: ["sts:AssumeRole"], resources: [files.roleArn, deploy.roleArn, lookup.roleArn] }));
    service.addToPolicy(new iam.PolicyStatement({ actions: ["amplify:GetApp", "amplify:GetBranch"], resources: [arn("amplify", `apps/${appId}`), arn("amplify", `apps/${appId}/branches/${branch}`)] }));
    for (const [name, value] of Object.entries({ ServiceRoleArn: service.roleArn, ExecutionRoleArn: execution.roleArn, ArtifactBucket: bucket.bucketName })) new cdk.CfnOutput(this, name, { value });
  }
}
