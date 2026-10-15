# Prospectus deployment and access contract

The public MIT app is hosted at https://prospectus.cyclotron.anth.us/ by Amplify app dnfou6dg4d6x2, proof branch, account 682849160744 / us-east-1. Source and dependencies are pinned. Amplify job 3 successfully deployed source 861c0d7 on 2026-10-14; this follow-up aligns authentication with Papyrus's Google-first flow.

## Google identity first, roles afterward

The browser uses Google federation through Cognito, authorization code and S256 PKCE. Google credentials remain in Secrets Manager prospectus/proof/oauth/google; the provider redirect remains https://prospectus-cyclotron-682849160744.auth.us-east-1.amazoncognito.com/oauth2/idpresponse. App callback is /auth/callback and logout returns to the app root.

The Google-only client permits no password authentication. A first Google sign-in creates its federated identity without an invitation or pre-enrolled native profile. The former pre-sign-up admission/linking Lambda, trigger and identity-management IAM permissions are removed. The existing pool, provider, client, domain and linked users are preserved.

Authentication alone does not grant CRM access. API Gateway verifies Cognito JWTs and the openid access-token scope; Kanbus requires the prospectus-members group. Operators grant that group to an existing signed-in identity. Application administrators receive both admin and prospectus-members in this dedicated pool. These groups do not confer AWS IAM privileges. Runtime Lambdas cannot create users or grant roles. Newly assigned groups require refreshed sign-in tokens.

## Storage and runtime

The backend contains a retained, versioned, TLS-only private S3 canonical bucket; a retained deletion-protected DynamoDB catalog with PITR and scoped GSIs; the dedicated Cognito pool, Google provider/client/domain and two app groups; a Rust provided.al2023 API Lambda with a scoped role/log group; and JWT-protected HTTP API routes. No AppSync, identity pool, alternative hosting pipeline, VPC or public CRM route is added.

Canonical paths and bytes stay ordinary Kanbus files. The catalog is supplemental metadata. Runtime S3 access is limited to cyclotron/prospectus and its Virtuus control namespace. DynamoDB access uses the same partition scope and does not allow Scan. There are no user-management permissions in runtime IAM.

The required operational configuration is tracked config/prospectus.kanbus.yml, stored unchanged at cyclotron/prospectus/.kanbus.yml in prospectus-cyclotron-records-682849160744. Initialization uses If-None-Match:* and expected bucket owner 682849160744, never overwriting an existing configuration or seeding customer/sample records.

## Standard delivery and verification

AmplifyProspectusBackendDeploy has AWS-managed AmplifyBackendDeployFullAccess and exact app/proof-branch trust. The existing standard hnb659fds account bootstrap has standard execution permissions following explicit owner approval. Marketing retains its unchanged restricted policy on a dedicated execution role. Routine publication remains the repository-backed Amplify build; auto-build stays disabled for this proof branch.

Checks cover Google-only code flow, absence of the pre-enrollment trigger, app groups, unchanged JWT/member enforcement, scoped runtime policies and actual offline Gen2 synthesis. Hosted acceptance requires anonymous 401, nonmember 403 and authorized CRM persistence. Source build success alone does not establish authenticated acceptance. No user or pool deletion is part of this alignment.
