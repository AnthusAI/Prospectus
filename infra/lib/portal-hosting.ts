import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as deployment from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { PORTAL_DOMAIN, TARGET_ACCOUNT } from "./scope";

/** The existing public zone for anth.us in papyrus-production. It is imported, never created. */
export const ANTHUS_ZONE_ID = "Z04979341DPRV5BDQNZMG";
export const ANTHUS_ZONE_NAME = "anth.us";

const LONG_CACHE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

/**
 * CloudFront Function (viewer request): client routes such as /auth/callback and dotted paths such
 * as /people/ada.lovelace serve index.html; /assets/* and known static file types pass through so a
 * missing asset stays a 404 instead of becoming a 200 HTML page.
 */
export const SPA_REWRITE_FUNCTION = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.indexOf("/assets/") === 0) return request;
  if (/\\.(css|js|mjs|map|json|txt|xml|ico|png|jpg|jpeg|gif|svg|webp|avif|woff|woff2|ttf|otf|webmanifest)$/.test(uri)) return request;
  request.uri = "/index.html";
  return request;
}
`;

export interface PortalHostingProps {
  /** Vite output (dist-portal): index.html, assets/ with hashed names, and public files. */
  assetDirectory: string;
  /** Origin of the accounts BFF the portal calls; the only non-Google origin the page may connect to. */
  apiOrigin: string;
  /** Further connect-src origins, for a sign-in method that needs one. */
  extraConnectSources?: readonly string[];
}

export function portalContentSecurityPolicy(apiOrigin: string, extraConnectSources: readonly string[] = []) {
  return [
    "default-src 'none'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "style-src 'self' https://accounts.google.com/gsi/style",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${["'self'", apiOrigin, "https://accounts.google.com/gsi/", ...extraConnectSources].join(" ")}`,
    "frame-src https://accounts.google.com/gsi/",
    "manifest-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** Private S3 bucket behind CloudFront (Origin Access Control) serving one.anth.us. */
export class PortalHosting extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: PortalHostingProps) {
    super(scope, id);
    cdk.Tags.of(this).add("anthus:surface", "portal");
    const region = cdk.Stack.of(this).region;
    if (!cdk.Token.isUnresolved(region) && region !== "us-east-1")
      throw new Error("Portal hosting must deploy in us-east-1: CloudFront certificates live there");

    this.bucket = new s3.Bucket(this, "Site", {
      bucketName: `anthus-one-portal-${TARGET_ACCOUNT}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(90),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: ANTHUS_ZONE_ID,
      zoneName: ANTHUS_ZONE_NAME,
    });
    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: PORTAL_DOMAIN,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      responseHeadersPolicyName: "anthus-one-portal-security",
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: portalContentSecurityPolicy(props.apiOrigin, props.extraConnectSources),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
            override: true,
          },
          // Google Identity Services opens its sign-in in a popup that must keep a window handle.
          { header: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups", override: true },
        ],
      },
    });

    const spaRewrite = new cloudfront.Function(this, "SpaRewrite", {
      functionName: "anthus-one-portal-spa-rewrite",
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(SPA_REWRITE_FUNCTION),
    });
    // index.html is revalidated on every request, so a deploy is visible immediately.
    const documentCache = new cloudfront.CachePolicy(this, "DocumentCache", {
      cachePolicyName: "anthus-one-portal-documents",
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "Anthus One portal (one.anth.us)",
      domainNames: [PORTAL_DOMAIN],
      certificate: this.certificate,
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: documentCache,
        responseHeadersPolicy: headers,
        compress: true,
        functionAssociations: [
          { function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        "/assets/*": {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: headers,
          compress: true,
        },
      },
      // A key missing from a bucket without ListBucket is a 403 from S3; present it as the 404 it is.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: "/404.html",
          ttl: cdk.Duration.seconds(10),
        },
      ],
    });

    new route53.ARecord(this, "AliasA", {
      zone,
      recordName: PORTAL_DOMAIN,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    });
    new route53.AaaaRecord(this, "AliasAaaa", {
      zone,
      recordName: PORTAL_DOMAIN,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    });

    // Publishing runs inside the same CloudFormation deployment. Name the Lambda role and log group so
    // the deployment's IAM stays reviewable, like the other roles in this stack.
    const logGroup = new logs.LogGroup(this, "PublishLogs", {
      logGroupName: "/aws/lambda/anthus-one-portal-publish",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const publishRole = new iam.Role(this, "PublishRole", {
      roleName: "anthus-one-portal-publish",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    publishRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn],
      }),
    );
    const common = {
      destinationBucket: this.bucket,
      role: publishRole,
      logGroup,
      prune: false,
      retainOnDelete: true,
    };
    // Hashed assets first and immutable; index.html last, so it never points at a missing asset.
    const assets = new deployment.BucketDeployment(this, "PublishAssets", {
      ...common,
      sources: [deployment.Source.asset(`${props.assetDirectory}/assets`)],
      destinationKeyPrefix: "assets",
      cacheControl: [deployment.CacheControl.fromString(LONG_CACHE)],
    });
    const documents = new deployment.BucketDeployment(this, "PublishDocuments", {
      ...common,
      sources: [
        deployment.Source.asset(props.assetDirectory, { exclude: ["assets", "assets/**"] }),
        deployment.Source.data("404.html", "<!doctype html><title>Not found</title><p>Not found.</p>\n"),
      ],
      cacheControl: [deployment.CacheControl.fromString(REVALIDATE)],
      distribution: this.distribution,
      distributionPaths: ["/index.html", "/"],
    });
    documents.node.addDependency(assets);
  }
}
