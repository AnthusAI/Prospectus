import {test} from "node:test";
import assert from "node:assert/strict";
import {App,Stack} from "aws-cdk-lib";
import {Bucket} from "aws-cdk-lib/aws-s3";
import {Code} from "aws-cdk-lib/aws-lambda";
import {Template} from "aws-cdk-lib/assertions";
import {ProspectusBackend} from "../lib/prospectus-backend";
function template(enabled:boolean,consoleClientEnabled=false,consolePairEnabled=false) {
 const stack=new Stack(new App(),"AccountsReview",{env:{account:"712236451410",region:"us-east-1"}});
 new ProspectusBackend(stack,"Prospectus",Code.fromBucket(Bucket.fromBucketName(stack,"Artifact","review-only-artifact"),"crm.zip"),undefined,enabled?{code:Code.fromInline("accounts artifact placeholder"),bffCode:Code.fromInline("BFF artifact placeholder"),googlePolicyReviewId:"synthetic-review-v1",consoleClientEnabled,consolePairEnabled,consoleFederationReviewId:"cyclotron-google-only-unlinked-v1-20261015",consolePairReviewId:"cyclotron-execution-pair-v1-20261015"}:undefined);
 return Template.fromStack(stack).toJSON();
}
test("Accounts additive synthesis preserves every existing CRM resource and adds only scoped UI routes",()=>{
 const before=template(false),after=template(true);
 for(const [id,resource] of Object.entries(before.Resources))assert.deepEqual(after.Resources[id],resource,`Existing CRM resource changed: ${id}`);
 const resources=Object.values(after.Resources) as any[],newResources=Object.entries(after.Resources).filter(([id])=>!before.Resources[id]).map(([,value])=>value as any);
 assert.equal(newResources.filter(value=>value.Type==="AWS::Lambda::Function").length,2);
 assert.deepEqual(newResources.filter(value=>value.Type==="AWS::IAM::Role").map(value=>value.Properties.RoleName).sort(),["prospectus-accounts-directory-runtime","prospectus-central-accounts-runtime"]);
 assert.equal(newResources.filter(value=>value.Type==="AWS::ApiGateway::Account").length,0);
 assert.equal(newResources.filter(value=>value.Type==="AWS::ApiGateway::RestApi").length,1);
 assert.equal(newResources.filter(value=>value.Type==="AWS::DynamoDB::Table" || value.Type==="AWS::S3::Bucket" || value.Type==="AWS::Cognito::UserPool" || value.Type==="AWS::Cognito::UserPoolClient").length,0);
 const routes=newResources.filter(value=>value.Type==="AWS::ApiGatewayV2::Route");assert.equal(routes.length,2);assert.ok(routes.every(route=>route.Properties.AuthorizationType==="JWT" && route.Properties.RouteKey.includes("/api/saas/")));
 const policies=newResources.filter(value=>value.Type==="AWS::IAM::Policy").flatMap(value=>value.Properties.PolicyDocument.Statement);
 assert.ok(!policies.some(value=>JSON.stringify(value.Action).includes("dynamodb") || JSON.stringify(value.Action).includes("cognito-idp") || JSON.stringify(value.Action).includes("s3:Delete")));
 assert.ok(!JSON.stringify(newResources).includes("test-invoke-stage"));
 const logWrites=policies.filter(value=>JSON.stringify(value.Action).includes("logs:PutLogEvents"));assert.equal(logWrites.length,2);assert.ok(logWrites.every(value=>value.Resource["Fn::GetAtt"]?.[1]==="Arn"));
 const invoke=policies.filter(value=>(Array.isArray(value.Action)?value.Action:[value.Action]).includes("execute-api:Invoke"));assert.equal(invoke.length,1);const invokeText=JSON.stringify(invoke);assert.ok(invokeText.includes("account-directory"));assert.ok(!invokeText.includes("account-directory*"));assert.equal(invoke[0].Resource.length,4);assert.ok(invokeText.includes("identities/google/resolve"));assert.ok(!invokeText.includes("/v1/accounts"));
 assert.ok(JSON.stringify(newResources).includes("prospectus-central/identities/*"));assert.equal(resources.filter(value=>value.Type==="AWS::Cognito::UserPoolClient").length,1);
});

test("approved console client stage adds only a dedicated public Google client and leaves directory policy unchanged",()=>{
 const before=template(true),after=template(true,true);
 for(const [id,resource] of Object.entries(before.Resources))assert.deepEqual(after.Resources[id],resource,`Existing resource changed during client-only stage: ${id}`);
 const added=Object.entries(after.Resources).filter(([id])=>!before.Resources[id]).map(([,resource])=>resource as any);
 assert.equal(added.length,1);assert.equal(added[0].Type,"AWS::Cognito::UserPoolClient");
 const client=added[0].Properties;
 assert.equal(client.GenerateSecret,false);assert.deepEqual(client.SupportedIdentityProviders,["Google"]);
 assert.deepEqual(client.AllowedOAuthFlows,["code"]);assert.deepEqual(client.AllowedOAuthScopes,["openid","email","profile"]);
 assert.deepEqual(client.CallbackURLs,["https://lab.cyclotron.anth.us/auth/callback"]);assert.deepEqual(client.LogoutURLs,["https://lab.cyclotron.anth.us/"]);
 assert.equal(client.EnableTokenRevocation,true);assert.ok(!client.ExplicitAuthFlows || client.ExplicitAuthFlows.every((flow:string)=>flow==="ALLOW_REFRESH_TOKEN_AUTH"));
 assert.ok(!JSON.stringify(after.Resources).includes("cyclotron-console-worker-runtime"));
});

test("verified console pair preserves directory and storage grants while allowing only exact console routes",()=>{
 const before=template(true,true),after=template(true,true,true);
 const values=Object.values(after.Resources) as any[];
 for(const [id,resource] of Object.entries(before.Resources) as [string,any][]) {
  if(["AWS::IAM::Role","AWS::IAM::Policy","AWS::Cognito::UserPoolClient","AWS::S3::Bucket","AWS::DynamoDB::Table"].includes(resource.Type))assert.deepEqual(after.Resources[id],resource,`Unrelated grants or resource changed: ${id}`);
 }
 const central=values.find(value=>value.Type==="AWS::Lambda::Function" && value.Properties.FunctionName==="prospectus-central-accounts");
 function resolve(value:any):any {
  if(typeof value!=="object" || value===null)return value;
  if(value.Ref)return value.Ref.includes("CyclotronConsoleBrowser")?"consoleclient":"syntheticclient";
  if(value["Fn::GetAtt"])return "arn:aws:iam::712236451410:role/prospectus-accounts-directory-runtime";
  if(value["Fn::Join"])return value["Fn::Join"][1].map(resolve).join(value["Fn::Join"][0]);
  throw new Error(`Unexpected template token ${JSON.stringify(value)}`);
 }
 const registry=JSON.parse(resolve(central.Properties.Environment.Variables.PROSPECTUS_PRODUCTS));
 const oldCentral=(Object.values(before.Resources) as any[]).find(value=>value.Type==="AWS::Lambda::Function" && value.Properties.FunctionName==="prospectus-central-accounts");
 assert.deepEqual(registry[0],JSON.parse(resolve(oldCentral.Properties.Environment.Variables.PROSPECTUS_PRODUCTS))[0]);
 assert.equal(registry.length,2);const consoleProduct=registry[1];
 const bff="arn:aws:iam::682849160744:role/cyclotron-console-bff-runtime",worker="arn:aws:iam::682849160744:role/cyclotron-console-worker-runtime";
 assert.deepEqual(consoleProduct.clientIds,["consoleclient"]);assert.notDeepEqual(consoleProduct.clientIds,registry[0].clientIds);
 assert.equal(consoleProduct.product,"cyclotron");assert.equal(consoleProduct.roleArn,bff);assert.deepEqual(consoleProduct.capabilities,["console:read","console:write"]);assert.equal(consoleProduct.accountDirectory,undefined);
 assert.deepEqual(consoleProduct.executionDelegation,{roleArn:worker,enrollmentRoleArn:bff,issuer:consoleProduct.issuer,clientId:consoleProduct.clientIds[0],enrollmentPolicyRevision:consoleProduct.googleFederation.reviewedPolicyId,reviewedPolicyId:"cyclotron-execution-pair-v1-20261015"});
 assert.equal(consoleProduct.googleFederation.reviewedPolicyId,"cyclotron-google-only-unlinked-v1-20261015");
 const policy=values.find(value=>value.Type==="AWS::ApiGateway::RestApi").Properties.Policy.Statement;
 const allow=(arn:string)=>policy.find((statement:any)=>statement.Effect==="Allow" && statement.Principal.AWS===arn);
 assert.deepEqual(allow(bff).Resource,["execute-api:/api/GET/v1/identities/me","execute-api:/api/POST/v1/identities/google/challenge","execute-api:/api/POST/v1/identities/google/resolve","execute-api:/api/GET/v1/accounts","execute-api:/api/POST/v1/accounts","execute-api:/api/GET/v1/accounts/*","execute-api:/api/POST/v1/accounts/*/authorize"]);
 assert.deepEqual(allow(worker).Resource,["execute-api:/api/GET/v1/identities/me","execute-api:/api/POST/v1/accounts/*/authorize"]);
 const denied=policy.find((statement:any)=>statement.Effect==="Deny").Condition.ArnNotEquals["aws:PrincipalArn"];
 assert.equal(denied.length,3);assert.deepEqual(denied.slice(1),[bff,worker]);
 const deploymentIds=(template:any)=>Object.entries(template.Resources).filter(([,value]:any)=>value.Type==="AWS::ApiGateway::Deployment").map(([id])=>id);
 assert.notDeepEqual(deploymentIds(after),deploymentIds(before),"Policy rollout must republish the existing API stage");
});
