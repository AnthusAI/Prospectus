import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as gateway from "aws-cdk-lib/aws-apigateway";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as s3 from "aws-cdk-lib/aws-s3";
import {Construct} from "constructs";
export interface AccountsPlaneOptions {code:lambda.Code;bffCode:lambda.Code;googlePolicyReviewId:string}
/** Additive resources only. No CRM role, client, namespace or authorizer edits. */
export class AccountsPlane extends Construct {
 readonly bff:lambda.Function;readonly endpoint:string;
 constructor(scope:Construct,id:string,bucket:s3.IBucket,pool:cognito.IUserPool,client:cognito.IUserPoolClient,options:AccountsPlaneOptions) {
  super(scope,id);if(!/^[A-Za-z0-9._:-]{1,128}$/.test(options.googlePolicyReviewId))throw new Error("Explicit reviewed Google-only policy ID required.");
  const runtime=new iam.Role(this,"Runtime",{assumedBy:new iam.ServicePrincipal("lambda.amazonaws.com")});
  const bffRole=new iam.Role(this,"BffRuntime",{assumedBy:new iam.ServicePrincipal("lambda.amazonaws.com")});
  const prefixes=["prospectus-central/identities/*","prospectus-central/accounts/*","_virtuus/prospectus-central/identities/*","_virtuus/prospectus-central/accounts/*"];
  runtime.addToPolicy(new iam.PolicyStatement({actions:["s3:GetObject","s3:PutObject"],resources:prefixes.map(prefix=>bucket.arnForObjects(prefix))}));
  // HeadBucket requires bucket-level ListBucket; explicit approval must cover it.
  runtime.addToPolicy(new iam.PolicyStatement({actions:["s3:ListBucket"],resources:[bucket.bucketArn]}));
  const keys=cdk.Stack.of(this);const registration={product:"prospectus-directory",roleArn:bffRole.roleArn,issuer:`https://cognito-idp.${keys.region}.amazonaws.com/${pool.userPoolId}`,clientIds:[client.userPoolClientId],capabilities:["console:read","members:read"],enabled:true,accountDirectory:true,googleFederation:{policy:"google-only-unlinked-v1",reviewedPolicyId:options.googlePolicyReviewId,clientId:client.userPoolClientId}};
  const centralLogs=new logs.LogGroup(this,"Logs",{retention:logs.RetentionDays.ONE_MONTH,removalPolicy:cdk.RemovalPolicy.RETAIN});const bffLogs=new logs.LogGroup(this,"BffLogs",{retention:logs.RetentionDays.ONE_MONTH,removalPolicy:cdk.RemovalPolicy.RETAIN});
  for(const [role,group] of [[runtime,centralLogs],[bffRole,bffLogs]] as const)role.addToPolicy(new iam.PolicyStatement({actions:["logs:CreateLogStream","logs:PutLogEvents"],resources:[`${group.logGroupArn}:*`]}));
  const central=new lambda.Function(this,"Handler",{runtime:lambda.Runtime.NODEJS_24_X,architecture:lambda.Architecture.X86_64,handler:"index.handler",code:options.code,role:runtime,logGroup:centralLogs,memorySize:512,timeout:cdk.Duration.seconds(28),environment:{PROSPECTUS_CANONICAL_ACCOUNTS:"enabled",PROSPECTUS_ACCOUNTS_BUCKET:bucket.bucketName,PROSPECTUS_ACCOUNTS_OWNER:keys.account,PROSPECTUS_PRODUCTS:cdk.Stack.of(this).toJsonString([registration])}});
  const api=new gateway.RestApi(this,"Api",{restApiName:"prospectus-accounts",cloudWatchRole:false,endpointTypes:[gateway.EndpointType.REGIONAL],deployOptions:{stageName:"api",dataTraceEnabled:false,loggingLevel:gateway.MethodLoggingLevel.OFF},defaultMethodOptions:{authorizationType:gateway.AuthorizationType.IAM}});
  const methods=api.root.addResource("v1").addResource("{proxy+}");for(const method of ["GET","POST"])methods.addMethod(method,new gateway.LambdaIntegration(central),{authorizationType:gateway.AuthorizationType.IAM});
  const invoke=[api.arnForExecuteApi("GET","/v1/account-directory*","api"),api.arnForExecuteApi("POST","/v1/identities/google/challenge","api"),api.arnForExecuteApi("POST","/v1/identities/google/resolve","api")];
  bffRole.addToPolicy(new iam.PolicyStatement({actions:["execute-api:Invoke"],resources:invoke}));
  api.addToResourcePolicy(new iam.PolicyStatement({principals:[new iam.ArnPrincipal(bffRole.roleArn)],actions:["execute-api:Invoke"],resources:["execute-api:/api/GET/v1/account-directory*","execute-api:/api/POST/v1/identities/google/challenge","execute-api:/api/POST/v1/identities/google/resolve"]}));
  api.addToResourcePolicy(new iam.PolicyStatement({effect:iam.Effect.DENY,principals:[new iam.AnyPrincipal()],actions:["execute-api:Invoke"],resources:["execute-api:/*"],conditions:{ArnNotEquals:{"aws:PrincipalArn":bffRole.roleArn}}}));
  this.bff=new lambda.Function(this,"Bff",{runtime:lambda.Runtime.NODEJS_24_X,architecture:lambda.Architecture.X86_64,handler:"index.handler",code:options.bffCode,role:bffRole,logGroup:bffLogs,memorySize:256,timeout:cdk.Duration.seconds(29),environment:{PROSPECTUS_CENTRAL_ENDPOINT:api.url,PROSPECTUS_DIRECTORY_REGISTRATION:keys.toJsonString(registration)}});
  this.endpoint=api.url;
 }
}
