import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { ProspectusBackend } from "../lib/prospectus-backend";
import { portalHostingDeployment } from "../lib/portal-deployment";
import { ANTHUS_ZONE_ID, ANTHUS_ZONE_NAME, SPA_REWRITE_FUNCTION } from "../lib/portal-hosting";
import { PORTAL_DOMAIN, TARGET_ACCOUNT, TARGET_REGION } from "../lib/scope";

const env = { account: TARGET_ACCOUNT, region: TARGET_REGION };
const assets = mkdtempSync(join(tmpdir(), "portal-assets-"));
mkdirSync(join(assets, "assets"));
writeFileSync(join(assets, "index.html"), "<!doctype html><div id=root></div>");
writeFileSync(join(assets, "assets", "portal-abc123.js"), "console.log(1)");

function backend(portal?: { assetDirectory: string }) {
  const stack = new cdk.Stack(new cdk.App(), "Review", { env });
  new ProspectusBackend(
    stack,
    "Prospectus",
    lambda.Code.fromBucket(s3.Bucket.fromBucketName(stack, "Artifact", "review-only"), "review-only.zip"),
    undefined,
    undefined,
    "synthetic-only",
    [],
    portal,
  );
  return Template.fromStack(stack);
}
const hosted = () => backend({ assetDirectory: assets });

test("disabled, the backend contains no portal resource at all", () => {
  const template = backend();
  for (const type of [
    "AWS::CloudFront::Distribution",
    "AWS::CertificateManager::Certificate",
    "AWS::Route53::RecordSet",
    "AWS::CloudFront::OriginAccessControl",
    "Custom::CDKBucketDeployment",
  ])
    template.resourceCountIs(type, 0);
  template.resourceCountIs("AWS::S3::Bucket", 1);
  assert.equal(portalHostingDeployment(), null, "the committed flag is off");
});

test("the portal bucket is private, encrypted, versioned and retained", () => {
  const template = hosted();
  template.resourceCountIs("AWS::S3::Bucket", 2);
  const [[, site]] = Object.entries(template.findResources("AWS::S3::Bucket")).filter(
    ([, bucket]) => bucket.Properties.BucketName === `anthus-one-portal-${TARGET_ACCOUNT}`,
  );
  assert.equal(site.DeletionPolicy, "Retain");
  assert.equal(site.UpdateReplacePolicy, "Retain");
  assert.deepEqual(site.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
  assert.deepEqual(site.Properties.VersioningConfiguration, { Status: "Enabled" });
  assert.equal(
    site.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault
      .SSEAlgorithm,
    "AES256",
  );
  const policies = Object.values(template.findResources("AWS::S3::BucketPolicy")).map((policy) =>
    JSON.stringify(policy.Properties.PolicyDocument),
  );
  const sitePolicy = policies.find((policy) => policy.includes("cloudfront.amazonaws.com"));
  assert.ok(sitePolicy, "only the CloudFront service principal reads the bucket");
  assert.ok(sitePolicy.includes("AWS:SourceArn"), "scoped to this distribution");
  const statements = JSON.parse(sitePolicy).Statement as any[];
  const allowed = statements.filter((statement) => statement.Effect === "Allow");
  assert.equal(allowed.length, 1, "one grant, to CloudFront alone");
  assert.deepEqual(allowed[0].Principal, { Service: "cloudfront.amazonaws.com" });
  assert.equal(allowed[0].Action, "s3:GetObject");
  assert.ok(
    statements.some((statement) => statement.Effect === "Deny" && sitePolicy.includes("aws:SecureTransport")),
  );
});

test("CloudFront reaches the bucket through Origin Access Control over HTTPS only", () => {
  const template = hosted();
  template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
    OriginAccessControlConfig: {
      OriginAccessControlOriginType: "s3",
      SigningBehavior: "always",
      SigningProtocol: "sigv4",
    },
  });
  const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution"));
  const config = distribution.Properties.DistributionConfig;
  assert.equal(config.Origins.length, 1);
  assert.deepEqual(config.Origins[0].S3OriginConfig, { OriginAccessIdentity: "" });
  assert.ok(config.Origins[0].OriginAccessControlId);
  assert.equal(config.DefaultCacheBehavior.ViewerProtocolPolicy, "redirect-to-https");
  assert.equal(config.CacheBehaviors[0].ViewerProtocolPolicy, "redirect-to-https");
  assert.deepEqual(config.DefaultCacheBehavior.AllowedMethods, ["GET", "HEAD"]);
  assert.equal(config.ViewerCertificate.MinimumProtocolVersion, "TLSv1.2_2021");
  assert.equal(config.ViewerCertificate.SslSupportMethod, "sni-only");
  assert.deepEqual(config.Aliases, [PORTAL_DOMAIN]);
  assert.equal(config.DefaultRootObject, "index.html");
});

test("client routes serve index.html with 200 and unknown asset paths 404", () => {
  const template = hosted();
  const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution"));
  const config = distribution.Properties.DistributionConfig;
  assert.deepEqual(
    config.DefaultCacheBehavior.FunctionAssociations.map((entry: any) => entry.EventType),
    ["viewer-request"],
  );
  assert.equal(config.CacheBehaviors[0].PathPattern, "/assets/*");
  assert.equal(config.CacheBehaviors[0].FunctionAssociations, undefined);
  // A blanket 403/404 -> index.html 200 would make missing assets look like pages; only S3's 403 for a
  // missing key is mapped, to a 404 page.
  assert.deepEqual(config.CustomErrorResponses, [
    { ErrorCode: 403, ResponseCode: 404, ResponsePagePath: "/404.html", ErrorCachingMinTTL: 10 },
  ]);
  template.hasResourceProperties("AWS::CloudFront::Function", {
    FunctionConfig: { Runtime: "cloudfront-js-2.0" },
    FunctionCode: SPA_REWRITE_FUNCTION,
  });
  const rewrite = new Function(`${SPA_REWRITE_FUNCTION}; return handler;`)() as (event: any) => any;
  const served = (uri: string) => rewrite({ request: { uri } }).uri;
  for (const uri of ["/", "/auth/callback", "/workspaces/acme", "/people/ada.lovelace", "/index.html"])
    assert.equal(served(uri), "/index.html", uri);
  for (const uri of [
    "/assets/portal-abc123.js",
    "/assets/missing-file",
    "/assets/nested/missing.css",
    "/favicon.ico",
    "/fonts/inter.woff2",
    "/config.json",
    "/robots.txt",
  ])
    assert.equal(served(uri), uri, uri);
});

test("hashed assets cache for a year, index.html revalidates, and index.html is invalidated", () => {
  const template = hosted();
  const deployments = Object.values(template.findResources("Custom::CDKBucketDeployment"));
  assert.equal(deployments.length, 2);
  const cacheControl = (deployment: any) => deployment.Properties.SystemMetadata["cache-control"];
  const byPrefix = (prefix: boolean) =>
    deployments.find((entry: any) => Boolean(entry.Properties.DestinationBucketKeyPrefix) === prefix)!;
  assert.equal(byPrefix(true).Properties.DestinationBucketKeyPrefix, "assets");
  assert.equal(cacheControl(byPrefix(true)), "public, max-age=31536000, immutable");
  assert.equal(cacheControl(byPrefix(false)), "no-cache");
  assert.deepEqual(byPrefix(false).Properties.DistributionPaths, ["/index.html", "/"]);
  assert.ok(byPrefix(false).Properties.DistributionId);
  assert.equal(byPrefix(true).Properties.DistributionId, undefined);
  assert.ok(byPrefix(false).DependsOn?.some((name: string) => name.includes("PublishAssets")));
  for (const deployment of deployments) assert.equal(deployment.Properties.Prune, false);
  const [documentCache] = Object.values(template.findResources("AWS::CloudFront::CachePolicy"));
  assert.equal(documentCache.Properties.CachePolicyConfig.MinTTL, 0);
  assert.equal(documentCache.Properties.CachePolicyConfig.DefaultTTL, 0);
  const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution"));
  assert.equal(
    distribution.Properties.DistributionConfig.CacheBehaviors[0].CachePolicyId,
    cloudfront.CachePolicy.CACHING_OPTIMIZED.cachePolicyId,
    "the managed CachingOptimized policy honors the immutable Cache-Control header",
  );
});

test("security headers: CSP for Google Identity Services and the accounts API, framing and transport", () => {
  const template = hosted();
  const [policy] = Object.values(template.findResources("AWS::CloudFront::ResponseHeadersPolicy"));
  const config = policy.Properties.ResponseHeadersPolicyConfig;
  const security = config.SecurityHeadersConfig;
  const joined = security.ContentSecurityPolicy.ContentSecurityPolicy["Fn::Join"][1] as unknown[];
  assert.ok(
    joined.some(
      (part: any) => part["Fn::GetAtt"]?.[0].includes("Api") && part["Fn::GetAtt"][1] === "ApiEndpoint",
    ),
    "connect-src carries the accounts API origin",
  );
  const csp = joined.map((part) => (typeof part === "string" ? part : "<api>")).join("");
  const directive = (name: string) => csp.split("; ").find((entry) => entry.startsWith(`${name} `)) ?? "";
  assert.equal(security.ContentSecurityPolicy.Override, true);
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("script-src 'self' https://accounts.google.com/gsi/client"));
  assert.ok(csp.includes("frame-src https://accounts.google.com/gsi/"));
  assert.ok(csp.includes("style-src 'self' https://accounts.google.com/gsi/style"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("object-src 'none'") && csp.includes("base-uri 'none'"));
  assert.ok(csp.includes("connect-src 'self' <api> https://accounts.google.com/gsi/;"));
  assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
  assert.ok(!directive("script-src").includes("*"));
  assert.deepEqual(security.StrictTransportSecurity, {
    AccessControlMaxAgeSec: 31536000,
    IncludeSubdomains: true,
    Override: true,
  });
  assert.deepEqual(security.ContentTypeOptions, { Override: true });
  assert.deepEqual(security.FrameOptions, { FrameOption: "DENY", Override: true });
  assert.deepEqual(security.ReferrerPolicy, {
    Override: true,
    ReferrerPolicy: "strict-origin-when-cross-origin",
  });
  const custom = Object.fromEntries(
    config.CustomHeadersConfig.Items.map((item: any) => [item.Header, item.Value]),
  );
  assert.equal(custom["Cross-Origin-Opener-Policy"], "same-origin-allow-popups");
  assert.match(custom["Permissions-Policy"], /camera=\(\)/);
  const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution"));
  const config2 = distribution.Properties.DistributionConfig;
  assert.ok(config2.DefaultCacheBehavior.ResponseHeadersPolicyId);
  assert.deepEqual(
    config2.DefaultCacheBehavior.ResponseHeadersPolicyId,
    config2.CacheBehaviors[0].ResponseHeadersPolicyId,
  );
});

test("the certificate is for one.anth.us, DNS-validated in the existing anth.us zone", () => {
  const template = hosted();
  template.resourceCountIs("AWS::CertificateManager::Certificate", 1);
  template.hasResourceProperties("AWS::CertificateManager::Certificate", {
    DomainName: PORTAL_DOMAIN,
    ValidationMethod: "DNS",
    DomainValidationOptions: [{ DomainName: PORTAL_DOMAIN, HostedZoneId: ANTHUS_ZONE_ID }],
  });
  template.resourceCountIs("AWS::Route53::HostedZone", 0);
  assert.equal(ANTHUS_ZONE_NAME, "anth.us");
  assert.equal(new cdk.Stack(new cdk.App(), "Region", { env }).region, TARGET_REGION);
  const wrong = new cdk.Stack(new cdk.App(), "Wrong", {
    env: { account: TARGET_ACCOUNT, region: "us-west-2" },
  });
  assert.throws(
    () =>
      new ProspectusBackend(
        wrong,
        "Prospectus",
        lambda.Code.fromBucket(s3.Bucket.fromBucketName(wrong, "Artifact", "review-only"), "review-only.zip"),
        undefined,
        undefined,
        "synthetic-only",
        [],
        { assetDirectory: assets },
      ),
    /us-east-1/,
  );
});

test("one.anth.us has A and AAAA alias records to the distribution, and nothing else in DNS", () => {
  const template = hosted();
  const records = Object.values(template.findResources("AWS::Route53::RecordSet"));
  assert.deepEqual(records.map((record: any) => record.Properties.Type).sort(), ["A", "AAAA"]);
  for (const record of records as any[]) {
    assert.equal(record.Properties.Name, `${PORTAL_DOMAIN}.`);
    assert.equal(record.Properties.HostedZoneId, ANTHUS_ZONE_ID);
    assert.ok(record.Properties.AliasTarget.HostedZoneId["Fn::FindInMap"][0].includes("CloudFront"));
    assert.ok(record.Properties.AliasTarget.DNSName["Fn::GetAtt"][0].includes("Distribution"));
  }
});

test("publishing: a scoped Lambda role, no wildcard buckets, no unreviewed privileges", () => {
  const template = hosted();
  const roles = Object.values(template.findResources("AWS::IAM::Role")) as any[];
  const publish = roles.find((role) => role.Properties.RoleName === "anthus-one-portal-publish");
  assert.ok(publish);
  assert.equal(publish.Properties.ManagedPolicyArns, undefined, "no AWSLambdaBasicExecutionRole");
  const policy = JSON.stringify(template.findResources("AWS::IAM::Policy"));
  for (const action of [
    "s3:GetObject*",
    "s3:PutObject",
    "s3:DeleteObject*",
    "s3:Abort*",
    "s3:GetBucket*",
    "s3:List*",
  ])
    assert.ok(policy.includes(action), action);
  assert.ok(
    policy.includes("cloudfront:CreateInvalidation") && policy.includes("cloudfront:GetInvalidation"),
  );
  for (const forbidden of [
    "iam:",
    "s3:DeleteBucket",
    "s3:PutBucketPolicy",
    "s3:*",
    "cloudfront:Update",
    "route53:",
  ]) {
    const portalPolicies = Object.values(template.findResources("AWS::IAM::Policy")).filter((entry: any) =>
      JSON.stringify(entry.Properties.Roles).includes("PublishRole"),
    );
    assert.ok(!JSON.stringify(portalPolicies).includes(forbidden), `${forbidden} must not be granted`);
  }
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/aws/lambda/anthus-one-portal-publish",
    RetentionInDays: 7,
  });
  template.hasResourceProperties("Custom::CDKBucketDeployment", {
    DestinationBucketName: Match.anyValue(),
    RetainOnDelete: true,
  });
});

test("the portal reaches the CRM data plane through nothing: no new API route, no CRM bucket access", () => {
  const template = hosted();
  const without = backend();
  assert.equal(
    Object.keys(template.findResources("AWS::ApiGatewayV2::Route")).length,
    Object.keys(without.findResources("AWS::ApiGatewayV2::Route")).length,
  );
  const outputs = template.toJSON().Resources;
  assert.ok(outputs);
  const publishPolicies = JSON.stringify(
    Object.values(template.findResources("AWS::IAM::Policy")).filter((entry: any) =>
      JSON.stringify(entry.Properties.Roles).includes("PublishRole"),
    ),
  );
  assert.ok(!publishPolicies.includes("CanonicalObjects"));
});
