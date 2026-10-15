import {test} from "node:test";
import assert from "node:assert/strict";
import {App,Stack} from "aws-cdk-lib";
import {Bucket} from "aws-cdk-lib/aws-s3";
import {Code} from "aws-cdk-lib/aws-lambda";
import {Template} from "aws-cdk-lib/assertions";
import {ProspectusBackend} from "../lib/prospectus-backend";
function template(enabled:boolean,consoleClientEnabled=false) {
 const stack=new Stack(new App(),"AccountsReview",{env:{account:"712236451410",region:"us-east-1"}});
 new ProspectusBackend(stack,"Prospectus",Code.fromBucket(Bucket.fromBucketName(stack,"Artifact","review-only-artifact"),"crm.zip"),undefined,enabled?{code:Code.fromInline("accounts artifact placeholder"),bffCode:Code.fromInline("BFF artifact placeholder"),googlePolicyReviewId:"synthetic-review-v1",consoleClientEnabled}:undefined);
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
