# Unprovisioned Google-authenticated Amplify backend review

The public MIT source is https://github.com/AnthusAI/Prospectus. The deployed CRM remains private to invited members. `proof` is a development validation branch; this proposal neither merges a PR nor promotes production. This delegate performed no AWS mutation. Eighteen local resource/security/admission tests, infrastructure compilation, actual Gen2 entry type checking, and full Gen2 review synthesis pass. A clean Amplify lockfile install also passed.

## Fixed destination and completed owner setup

Hosting/backend/auth/storage stay in cyclotron-production account 682849160744 / us-east-1. Approved Amplify metadata app: dnfou6dg4d6x2, ARN arn:aws:amplify:us-east-1:682849160744:apps/dnfou6dg4d6x2. The parent created the app and prepared its proof domain association; no backend or live Google-authenticated CRM exists yet.

The parent reports DNS change C0694425RZ6YOT33OZSK INSYNC: certificate-validation CNAME `_89a0e42e1f0ebdc9fef687ac1395ce41.cyclotron.anth.us` points to `_edda7ff777e05849b3db30de1dee3138.wzccmgtwzk.acm-validations.aws`; `prospectus.cyclotron.anth.us` points to `dgjphcuske3pw.cloudfront.net`. Legacy account 335163751677 hosts only the anth.us DNS zone Z02552332GG6AM25SFP73 for this work. No hosting, storage, auth, or IAM is provisioned there. Existing marketing distribution E3NML5WYPZ6I4B and parent cyclotron A/AAAA records remain intact. The marketing *.anth.us certificate does not cover the nested app hostname; Amplify manages the new app certificate.

## Exact Google prerequisite — owner action tomorrow

The owner will create a new Google project and a Web application OAuth client. Register this exact **Google-to-Cognito** authorized redirect URI:

`https://prospectus-cyclotron-682849160744.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`

Store the real credentials in AWS Secrets Manager, cyclotron-production / us-east-1, exact name **prospectus/proof/oauth/google**, JSON keys **client_id** and **client_secret**. No placeholder secret, Google client, credential file, or secret value is created by this proposal. The template imports this exact future secret with dynamic references. Its absence blocks deployment; do not provision persistent deployment grants or submit the backend tonight merely to encounter that known failure.

Cognito redirects back to `https://prospectus.cyclotron.anth.us/auth/callback`; logout returns to `https://prospectus.cyclotron.anth.us/`. These are separate from the Google provider callback. The frontend uses Google + authorization code + S256 PKCE and sends its Cognito access token to the REST API.

The owner must also explicitly approve the intended Google email for a local Cognito invitation and prospectus-members enrollment. No user is created or invitation sent by these stacks. The pre-sign-up function checks the Google-mapped verified email, finds one enabled local user, verifies its existing prospectus-members group, and links the trusted Google subject to that profile. Missing, ambiguous, disabled, unverified or nonmember identities are denied before federation creates a profile. It never creates users, adds group memberships, trusts clientMetadata, or admits an email domain broadly. Google first-sign-in, native-profile linking, emitted group claims and the final UI workflow still require live verification after real provider credentials and approved membership exist.

## Application resource delta

The Gen2 root owns two explicitly named branch-linking Node Lambda helpers, their roles/policies, two retained one-week helper log groups, its branch-linking custom resource, and the nested Prospectus backend. All helper log writes target only their own declared log groups; no AWSLambdaBasicExecutionRole is attached.

The nested backend adds one retained versioned TLS-only private canonical S3 bucket; one retained deletion-protected on-demand DynamoDB metadata table with PITR and by_type/by_status/by_type_status GSIs; one retained deletion-protected dedicated Cognito pool, Google-only public authorization-code client, Google identity provider, hosted Cognito domain and prospectus-members group; one Node22 Google admission Lambda/role/one-week log group and pool-scoped invoke permission; one Rust provided.al2023 x86_64 API Lambda/role/one-month log group; one HTTP API/JWT authorizer/default stage/Lambda integration and GET/POST/PATCH/DELETE protected proxy routes with their invoke permissions. No users, invitations, public intake, identity pool, AppSync, custom frontend CloudFront stack, CodePipeline, VPC or fixed compute resources.

Canonical files preserve ordinary Kanbus paths and raw bytes under `cyclotron/prospectus/`. Supplemental journal controls live separately under `_virtuus/cyclotron/prospectus/`. DynamoDB stores metadata/pointers/hash/revision, never authoritative canonical file bodies.

## Runtime and helper access

Authoritative statements are in `infra/cdk.out/ProspectusBackendReview.template.json` and `.artifacts/amplify-review/` after local checks.

- API role prospectus-cyclotron-runtime trusts Lambda. CreateLogStream/PutLogEvents address only its API log group. ListBucket addresses only the canonical bucket with the two project/control prefixes. GetObject/PutObject/DeleteObject address only those prefixes; no DeleteObjectVersion or bucket purge. DynamoDB GetItem/PutItem/DeleteItem/Query address only its table with LeadingKeys=cyclotron/prospectus; Query addresses the three named indexes with type/status namespace key prefixes. No Scan, DeleteTable, IAM, Cognito administration, Secrets Manager, DNS or other-project rights.
- HTTP API verifies the dedicated Cognito issuer/client audience and openid access-token scope. The Rust Lambda requires prospectus-members from trusted API Gateway JWT claim context. No function URL or public CRM route is defined.
- Google admission role prospectus-cyclotron-google-admission trusts Lambda. It can write only its own log group and DescribeUserPool/ListUsers/AdminListGroupsForUser/AdminLinkProviderForUser only on its exact pool ARN. Identity linking is a security capability included for explicit approval. It cannot read the Google secret, create users, assign groups or access CRM objects/catalog. Only its own Cognito pool may invoke it.
- Helper role prospectus-dnfou6dg4d6x2-proof-linker can GetBranch/UpdateBranch only on this exact account/region/app/proof branch, plus its own log writes. Helper role prospectus-dnfou6dg4d6x2-proof-provider can invoke only the linker function, plus its own log writes. Their physical names are explicit, avoiding CloudFormation name truncation and unstable IAM scopes.

## Separate deployment stack and exact review boundary

`infra/cdk.out/ProspectusDeploymentReview.template.json` adds a separate file-only prspctus bootstrap: retained versioned private asset bucket `cdk-prspctus-assets-682849160744-us-east-1`, SSM `/cdk-bootstrap/prspctus/version` value8, and five roles (ProspectusAmplifyService, file publisher, deploy, CloudFormation execution, lookup). AppId and branch parameters default to and accept only dnfou6dg4d6x2 / proof. No ECR repository, existing bootstrap changes, human role, GitHub OIDC grant, secret creation or DNS permission.

Amplify service trust requires amplify.amazonaws.com, exact SourceAccount and app SourceArn. It assumes only its file/deploy/lookup roles and reads only this app/branch and corresponding stacks. File publishing reads/writes only the new asset bucket. Deploy manages only amplify-dnfou6dg4d6x2-proof-* stacks and passes only the separate execution role to CloudFormation. Lookup reads only those stacks and the new bootstrap version. CloudFormation reads this asset bucket and the exact OAuth secret; provisions the named app bucket/table/functions/log groups/roles and Cognito/HTTP API resources; passes only those app roles to Lambda; invokes only the two branch helpers. No managed-policy attachment is granted. Inline policy creation on those named roles and Lambda code replacement are powerful provisioning capabilities explicitly included in this review.

Necessary broader service scopes are also explicit: CreateUserPool/DescribeUserPoolDomain use Resource* with RequestedRegion=us-east-1; Cognito pool/provider management covers all pool ARNs in this account/region because their generated pool ID is unknown before creation; HTTP API management covers /apis and /apis/* in us-east-1. DescribeLogGroups is an unscoped read. ValidateTemplate/GetTemplateSummary are regional unscoped reads. The exact synthesized policy must receive action-time platform approval once the Google configuration is complete.

The current marketing CDKToolkit has version32/qualifier hnb659fds and execution policy CyclotronMarketingCdkExecution v6. It lacks Cognito/DynamoDB/Lambda/API provisioning rights. Preserve it. pipeline-deploy has no qualifier/role flag; code sets CDK's public bootstrapQualifier context before defineBackend creates its App and verifies the bound synthesizer. The actual Gen2 assembly confirms prspctus artifact/deploy/execution/lookup ARNs and SSM parameter, including no marketing execution role. Amplify sandbox's default bootstrap check is not this deployment route.

## Build and first proof

The reviewed public x86-64 build image is `public.ecr.aws/docker/library/node@sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d` (Debian bookworm, Node22.23.3). Its curl/git/OpenSSH/bash/sh/npm/apt tools were verified in an isolated container. No new image repository is needed. The SDK scope guard verifies account/region/app/proof branch; no AWS CLI is required inside this image.

Release still requires full source-lock Kanbus/Virtuus revisions, a matching git-pinned Cargo dependency, completed source gates, and the real Linux Rust bootstrap.zip/provenance. The package script requires the API's own numeric rust-toolchain.toml and installs that exact version, currently1.98.1; no root/stable fallback exists. No fake binary is supplied. CI adds a separate loopback filesystem browser proof with a fresh unlogged token, disposable folder, owned process cleanup, disabled traces/HTML reports and redacted diagnostics. That new CI script has syntax validation; its full clean-run execution waits for source pins/gates. The parent already verified the local real API/browser workflow.

A once-off reviewed backend proof may run from the locally committed app and dependency revisions after credentials, real binary and action-time IAM/security approval are ready; GitHub repository connection is not technically required for ampx pipeline-deploy. Set CI=1 explicitly for that documented one-off proof, use the SDK scope guard, and invoke pipeline-deploy for dnfou6dg4d6x2/proof. This does not publish frontend content. Routine publication remains repository-backed Amplify CI; no manual site-content sync is introduced.

Before hosted acceptance verify anonymous401, nonmember403, approved Google member read/create/move with real S3 persistence/revision conflicts, PKCE callback/logout, and final private UI at the requested hostname. Adapter fixture proof and local browser proof are not a deployed app. All persistent grants/backend execution are pending credentials and concrete approval, not denied or uncertain writes by this delegate.

## One-time canonical project initialization

The API needs the ordinary project configuration before member requests can work. After the real reviewed backend exists, a separately reviewed operator action writes **only** tracked `config/prospectus.kanbus.yml` unchanged to bucket **prospectus-cyclotron-records-682849160744**, key **cyclotron/prospectus/.kanbus.yml**. Require `If-None-Match: *`; if a file already exists, stop and inspect it instead of replacing it. No customer records are seeded. Do not use the root development-board .kanbus.yml. The backend outputs ObjectBucketName, CanonicalNamespace and ConfigurationObjectKey for exact verification. No runtime CF initializer or additional seed grant is added. This is canonical data setup, separate from site publication.

Reviewed future operator command (not executed):

```sh
aws s3api put-object --bucket prospectus-cyclotron-records-682849160744 --key cyclotron/prospectus/.kanbus.yml --body config/prospectus.kanbus.yml --if-none-match '*' --expected-bucket-owner 682849160744 --profile cyclotron-production --region us-east-1
```

The approved local Cognito invitation and explicit prospectus-members enrollment must also precede that person's first Google sign-in. Until real Google credentials, membership and this config object exist, a hosted member CRUD proof is incomplete.
