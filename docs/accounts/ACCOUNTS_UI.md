# Accounts directory UI and additive deployment contract

Based on deployed Papyrus main13155d7. This branch is separate from the CRM owner's checkout. Prospects/contacts remain sales records; SaaS accounts are canonical organizations with memberships and product entitlements. No demo production organizations or billing are introduced.

Specifications before implementation:

- A signed-in user can open Accounts even without CRM prospect-membership. The Accounts view never grants access to prospects.
- A separately registered directory BFF runtime may request account-directory reads. Ordinary console runtime registrations cannot call directory routes. This is a trusted deployment-registry flag, never a browser field.
- All directory users see only canonical accounts where their canonical Person has active membership. CRM admin claims do not grant platform-wide organization enumeration.
- Owners/admins with account-scoped members:read see the selected account's membership list; member/viewer users see only their own membership. Product entitlements and own role come from that same canonical account document. Reads grant no membership or product access.
- Normal product console list/authorize semantics retain caller-product entitlement enforcement; the management directory is an explicitly registered read-only surface across products, still bounded by own account membership.
- Unknown/pending identity, empty account list, loading, unconfigured service and failures have distinct honest states. No fallback demo organizations are shown.
- The browser calls JWT-protected BFF routes. Only the server signs the central IAM API request. Fresh canonical Google enrollment requires the existing challenge/nonce plus independently verified access/ID evidence; a legacy CRM access token or email alone cannot enroll.
- Additive Gen2 integration reuses the existing private versioned bucket and leaves CRM logical IDs, JWT routes, data namespace, pool/client and permissions unchanged. No cloud activation occurs without exact approval.

## Reviewable increments and API

The independently deployable UI increment is `f87a1d4eb26752a3f553a295bd7004ad888c5984`, directly above deployed main `13155d7`. It introduces no backend resource or permission change. Without `VITE_ACCOUNTS_BFF_URL`, Accounts reports that the service is not configured. The backend increment layers on that commit and remains disabled in `accounts/deployment.json`.

The JWT-protected browser BFF exposes only:

- `GET /api/saas/accounts`: `{person, accounts}`; an unenrolled identity returns `person:null` and an empty list.
- `GET /api/saas/accounts/:id`: `{account}` including own role, real product entitlements and permitted memberships.
- `POST /api/saas/identity/challenge`: an empty JSON object starts fresh enrollment.
- `POST /api/saas/identity/resolve`: `{challengeId,idToken}` forwards independently verified access and ID evidence to the fixed central service. ID evidence is transient and never stored by the frontend.

Server-only SigV4 routes are `/v1/account-directory`, `/v1/account-directory/:id` and the existing Google challenge/resolve routes. The SDK exports directory DTOs through `@anthus/prospectus-accounts-client/directory`; AWS signing remains in `/server`, outside the browser bundle. No account creation, membership update, entitlement grant, global enumeration or billing endpoint is exposed by this UI runtime.

The existing CRM Google client and callback are reused with fresh challenge nonce, PKCE and prompt binding. This does not change its provider, callbacks, client settings or CRM authorization. Production activation still requires review of the exact Google-only policy and registry. Other product/console principals are not automatically registered.

## Activation and deployment handoff

Only the designated CRM deployment owner integrates and deploys, through the parent. Do not deploy this branch directly or edit that owner's checkout. The code is additive to the existing Gen2 custom backend: two Node24 x86_64 Lambdas, a regional IAM REST API (no account-wide API Gateway logging-role configuration) and two JWT-protected GET/POST `/api/saas/{proxy+}` routes on the existing HTTP API. Existing CRM resource definitions are regression-tested as identical before and after enabling Accounts.

Before changing `enabled:false`, obtain action-time approval for the exact synthesized changes, Google policy review ID and new runtime roles. The central role can GetObject/PutObject only in these existing-bucket scopes:

- `prospectus-central/identities/*`
- `prospectus-central/accounts/*`
- `_virtuus/prospectus-central/identities/*`
- `_virtuus/prospectus-central/accounts/*`

The native bridge sends `x-amz-expected-bucket-owner` on every S3 call instead of a HeadBucket check. The runtime's bucket-level `s3:ListBucket` grant carries a `StringLike s3:prefix` condition covering only the four `prospectus-central` identity and account scopes, so it cannot list other record keys; this list permission must be included explicitly in approval. The two bridge processes live at module scope and survive warm Lambda invocations, restarting only after a bridge failure or exit. No S3 DeleteObject, DynamoDB authority, Cognito management or deploy-role expansion is added. The directory BFF role receives Invoke only on its directory GET and Google challenge/resolve POST routes. Runtime and resource-policy checks both restrict the caller. Existing CRM runtime permissions stay unchanged.

The bucket remains `prospectus-records-712236451410` in Papyrus production. CRM namespace `cyclotron/prospectus` remains unchanged. Read-only inspection found the four new central scopes empty; no production records were seeded. An enrolled user may therefore correctly see no accounts until separately authorized real provisioning creates memberships and entitlements.

The deployment output supplies `VITE_ACCOUNTS_BFF_URL`; absence remains an honest unavailable state. After approved activation, verify a fresh Google login, account persistence, read isolation, member visibility and rejection paths against deployed IAM/S3 before claiming live compatibility. No such cloud writes, deployment or live-Google test occurred in this task.

## Verification evidence

Local checks: 44 root tests passed plus two server-signing security tests (two optional browser tests skipped), 20 durable account/directory/BFF tests passed, all 29 durable identity recovery/concurrency tests passed, and both browser suites passed using disposable canonical files and synthetic RSA identities. Infra tests passed (10), including exact preservation of pre-existing CRM resources; enabled actual Gen2 offline synthesis passed. Typecheck, frontend build, Node handler bundles and SDK declaration build passed. Browser tests cover owner/member/outsider isolation, loading/empty/error states and real persisted BFF data, with no production auth shortcuts.

Independent console checkpoint `785ebf8` verifies the real Python BFF against canonical handlers and durable Virtuus accounts across restart, including selected workspace authorization, viewer/member distinctions, revocation, creation replay and cross-product denial. It is local synthetic proof, not a hosted console or IAM claim.

Disabled deployment skips Accounts native packaging (`accounts/build-deployment.ts`), so this preparation does not add native build work to routine CRM deployments. The native Linux build is separately validated before activation; current task verification and any packaging limitation are recorded in the final handoff.

## Activation integration

The central deployment includes the Accounts runtime only after the approved Linux package passes its Node24 checks. The integration preserves the separately disabled synthetic intake and the existing CRM bucket, catalog, namespace, Cognito client and authorization. CI checks the actual additive Gen2 assembly and tests account/member isolation with persisted disposable fixtures. Deployment never seeds an organization or grants a human membership. Real Google sign-in must satisfy the existing freshness and nonce checks; these checks are not relaxed for an existing hosted-UI session.
