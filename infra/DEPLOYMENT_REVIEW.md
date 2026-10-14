# Standard Amplify Gen2 backend setup review

The public MIT source is https://github.com/AnthusAI/Prospectus. The deployed CRM remains private to invited members. `proof` is a development validation branch. Local infrastructure checks compile the resources, test security/admission behavior, type-check the Gen2 entry and synthesize review artifacts without AWS calls. The owner explicitly authorized standard Amplify service-role creation/assignment and deployment in message `Sentinel_0772ada47d38819189f919bc6b35f75c`. On 2026-10-14, `AmplifyProspectusBackendDeploy` was created with the standard Gen2 managed policy and assigned to this app. No existing marketing policy was changed and no backend has yet been deployed.

## Fixed destination and completed owner setup

Hosting/backend/auth/storage stay in cyclotron-production account 682849160744 / us-east-1. Approved Amplify metadata app: dnfou6dg4d6x2, ARN arn:aws:amplify:us-east-1:682849160744:apps/dnfou6dg4d6x2. The parent created the app and prepared its proof domain association; no backend or live Google-authenticated CRM exists yet.

The parent reports DNS change C0694425RZ6YOT33OZSK INSYNC: certificate-validation CNAME `_89a0e42e1f0ebdc9fef687ac1395ce41.cyclotron.anth.us` points to `_edda7ff777e05849b3db30de1dee3138.wzccmgtwzk.acm-validations.aws`; `prospectus.cyclotron.anth.us` points to `dgjphcuske3pw.cloudfront.net`. Legacy account 335163751677 hosts only the anth.us DNS zone Z02552332GG6AM25SFP73 for this work. No hosting, storage, auth, or IAM is provisioned there. Existing marketing distribution E3NML5WYPZ6I4B and parent cyclotron A/AAAA records remain intact. The marketing *.anth.us certificate does not cover the nested app hostname; Amplify manages the new app certificate.

## Exact Google prerequisite — owner setup in progress

The owner will create a new Google project and a Web application OAuth client. Register this exact **Google-to-Cognito** authorized redirect URI:

`https://prospectus-cyclotron-682849160744.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`

The owner's earlier exact deferral was: "I will have to create a new project and oauth client for that tomorrow." The owner is now creating the Google project; usable client credentials are still unavailable. Store the real credentials in AWS Secrets Manager, cyclotron-production / us-east-1, exact name **prospectus/proof/oauth/google**, JSON keys **client_id** and **client_secret**. No placeholder secret, Google client, credential file, or secret value is supplied by the application. The backend imports this exact future secret with dynamic references. Its absence is a known prerequisite for deployment, separate from the approved service-role setup.

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

## Standard service role and existing account bootstrap

Amplify's supported setup uses a backend service role selected in the app's IAM roles settings. A suitable existing role may be selected, or Amplify can create a service role during normal app setup. The proposed Gen2 backend service-role managed policy is exactly **arn:aws:iam::aws:policy/service-role/AmplifyBackendDeployFullAccess**. AWS manages that policy; its current version was read as v9 during the account investigation. The role must trust **amplify.amazonaws.com**, with SourceAccount **682849160744** and SourceArn restricted to **arn:aws:amplify:us-east-1:682849160744:apps/dnfou6dg4d6x2**. Standard creation/assignment and deployment are now explicitly authorized; any additional permission expansion must be reported for separate approval. No custom service-role name or separate bootstrap stack is required by this application. See [Amplify service-role setup](https://docs.aws.amazon.com/amplify/latest/userguide/amplify-service-role.html) and [the Gen2 deployment managed policy](https://docs.aws.amazon.com/amplify/latest/userguide/security-iam-awsmanpol.html).

The read-only account inspection before approved setup found no service role or repository connection on app **dnfou6dg4d6x2**, and none of the account's 17 IAM roles trusted Amplify. The **proof** branch had **zero deployment jobs**. There was no observed deployment error to attribute to service-role permissions or the account bootstrap.

The existing **CDKToolkit**, qualifier **hnb659fds**, version **32**, already supplies the standard deployment, CloudFormation execution, file publishing, image publishing and lookup roles. Prospectus uses CDK's standard bootstrap settings. The forced custom qualifier and bespoke five-role deployment proposal were removed from the local source; they were an application implementation choice, not an Amplify prerequisite. See [Amplify Gen2 account setup](https://docs.amplify.aws/react/start/account-setup/).

The managed Gen2 policy delegates provisioning to CDK roles. The existing CloudFormation execution role has only **CyclotronMarketingCdkExecution v6**, whose marketing-only scope does not include Prospectus Cognito, DynamoDB, Lambda or HTTP API provisioning. This is a known configuration concern, not a demonstrated deployment failure. Selecting a service role does not itself change that execution policy. Preserve the current policy and existing Cyclotron sites; investigate an actual authorized deployment error before proposing any additional permission change. No rebootstrap, role expansion or alternative deployment path is authorized by this document.

## Build and first proof

The reviewed public x86-64 build image is `public.ecr.aws/docker/library/node@sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d` (Debian bookworm, Node22.23.3). Its curl/git/OpenSSH/bash/sh/npm/apt tools were verified in an isolated container. No new image repository is needed. The SDK scope guard verifies account/region/app/proof branch; no AWS CLI is required inside this image.

Release requires full source-lock Kanbus/Virtuus revisions, a matching git-pinned Cargo dependency, completed source gates, and the real Linux Rust bootstrap.zip/provenance. The package script requires the API's own numeric rust-toolchain.toml and installs that exact version, currently 1.98.1; no root/stable fallback exists. No fake binary is supplied. The preceding source revision passed [Prospectus CI](https://github.com/AnthusAI/Prospectus/actions/runs/38501432562), including source-pinned packaging and the real loopback filesystem browser proof. [Kanbus CI](https://github.com/AnthusAI/Kanbus/actions/runs/38498995820) and [Virtuus CI](https://github.com/AnthusAI/Virtuus/actions/runs/38500518836) also passed. Browser verification uses a fresh unlogged token, disposable folder, owned process cleanup, disabled traces/HTML reports and redacted diagnostics. The local API/browser workflow and separate real AWS storage fixture proofs are recorded in the existing evidence files. These results establish the earlier source baseline; the local standard-bootstrap change requires its own local checks.

Complete the approved normal Amplify service-role and repository setup for this app and its reviewed proof branch. Keep proof branch auto-build disabled until Google credentials, reviewed resources and source gates are ready. The repository's amplify.yml packages the source-pinned Rust backend and runs normal Gen2 pipeline-deploy before building the frontend. The SDK scope guard verifies account/region/app/proof branch. Routine publication stays repository-backed Amplify CI; no manual frontend-content sync or alternate deployment route is introduced.

Before hosted acceptance verify anonymous 401, nonmember 403, approved Google member read/create/move with real S3 persistence/revision conflicts, PKCE callback/logout, and final private UI at the requested hostname. Adapter fixture proof and local browser proof are not a deployed app. Automatic approval review blocked the earlier setup/deployment instruction before execution; subsequent explicit owner confirmation now authorizes standard service-role setup and deployment. Google credentials are still unavailable, and at this local update there is no uncertain IAM write or deployed backend. Any additional account-policy expansion requires a new concrete review rather than automatic retry through another route.

## One-time canonical project initialization

The API needs the ordinary project configuration before member requests can work. After the real reviewed backend exists, a separately reviewed operator action writes **only** tracked `config/prospectus.kanbus.yml` unchanged to bucket **prospectus-cyclotron-records-682849160744**, key **cyclotron/prospectus/.kanbus.yml**. Require `If-None-Match: *`; if a file already exists, stop and inspect it instead of replacing it. No customer records are seeded. Do not use the root development-board .kanbus.yml. The backend outputs ObjectBucketName, CanonicalNamespace and ConfigurationObjectKey for exact verification. No runtime CF initializer or additional seed grant is added. This is canonical data setup, separate from site publication.

Reviewed future operator command (not executed):

```sh
aws s3api put-object --bucket prospectus-cyclotron-records-682849160744 --key cyclotron/prospectus/.kanbus.yml --body config/prospectus.kanbus.yml --if-none-match '*' --expected-bucket-owner 682849160744 --profile cyclotron-production --region us-east-1
```

The approved local Cognito invitation and explicit prospectus-members enrollment must also precede that person's first Google sign-in. Until real Google credentials, membership and this config object exist, a hosted member CRUD proof is incomplete.
