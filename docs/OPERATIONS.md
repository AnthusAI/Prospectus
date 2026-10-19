# Operations

## Where it runs

| Item | Value |
| --- | --- |
| Application | https://prospectus.anth.us/ |
| AWS account and region | `712236451410` (papyrus-production), `us-east-1` |
| Amplify app and branch | `d15sc1sptohtqb`, `main` |
| Record bucket | `prospectus-records-712236451410` |
| Data namespace | `cyclotron/prospectus` (retained data identity, not a second Cyclotron application) |
| Public marketing site | https://pr.ospect.us/ (Prospectus-web repository) |
| Public company site | anth.us, served by AnthusAI/Anth.us-Papyrus; the superseded Gatsby site is not a target |
| Cyclotron Lab | https://lab.cyclotron.anth.us/ consumes this central service; it has no Prospectus deployment of its own |

The dedicated Cyclotron hosting that preceded the central application is retired and redirects here. The old exclusive backend, storage and identity resources were removed after accepted central access and explicit deletion confirmation; the central application and shared resources were preserved.

## Cloud access rules

- Cloud threads and CI have no AWS access. Nothing a worker does deploys.
- Every AWS action runs on Ryan's M1 Mac, logged in to the AWS CLI with Touch ID. The AWS console in a browser is not used.
- New persistent IAM or security resources, OAuth changes and operator grants need concrete approval first.
- Deployment is only through the Amplify `main` pipeline. There is no manual content sync and no separate branch deployment.

## Deployment

`amplify.yml` runs the backend pipeline: verify scope, check out the pinned Kanbus sources, build the shared UI, `npm ci`, typecheck, test, package the Linux Kanbus API, build the intake bundle when enabled, build the Accounts bundles, run the infrastructure checks and `ampx pipeline-deploy`. The frontend phase writes `.env.production.local` from the Amplify outputs (`infra/scripts/write-frontend-env.mjs`) and runs `npm run build`. Keep the reviewed pinned Node build image and `infra/hosting-settings.json`, including the single-page-app rewrite and disabled legacy CLI overrides.

The Kanbus API, the shared UI package and Virtuus are pinned independently in `source-lock.json`, so a UI-only release cannot replace the deployed API. `.github/workflows/package-backend.yml` builds a reviewed backend package on demand.

Do not rewrite canonical paths or delete data in a UI release.

### Activation flags

Each additive slice is switched by a checked-in file that the pipeline reads. Changing a flag is a reviewed source change that deploys on merge.

| File | Controls | Value on this branch |
| --- | --- | --- |
| `accounts/deployment.json` | Central Accounts plane; needs `storageMode` `canonical-virtuus-v1` and a Google policy review ID | `enabled: true`, review `papyrus-google-only-unlinked-v1-20261015` |
| `accounts/console-deployment.json` | Cyclotron console Cognito client (`clientEnabled`) and its BFF and worker role pair (`pairEnabled`); the pair requires the client | both `true` |
| `accounts/papyrus-sites.json` | Registered Papyrus sites, at most 40 | empty |
| `accounts/operator-grants.json` | Operators who may read the whole directory | one reviewed grant |
| `evaluation-deployment.json` | Inquiry intake runtime and its mode (`synthetic-only` or `real-contacts`) | `enabled: false`, `synthetic-only` here; `main` carries `enabled: true`, `real-contacts` since the engage-page change |

Whether a flag is deployed is a fact about the cloud account, not the repository. Check the Amplify build history before claiming an activation is live. The anth.us engage form is not a working Prospectus intake until the intake runtime is deployed and the public form's endpoint and privacy notice settings in AnthusAI/Anth.us-Papyrus point at the `EvaluationIntakeUrl` output.

### Turning on a Papyrus site

Follow [accounts/PAPYRUS_SITES.md](accounts/PAPYRUS_SITES.md). The registry entry only exposes the site's read routes; the site's own runtime role also needs `execute-api:Invoke` on the same routes in its own account. Site cutover tracking is Kanbus `kanbus-2755969c` with Papyrus `PPY-58f107`.

### Enabling or changing the Accounts plane

Before changing `enabled` or any role pair, get action-time approval for the exact synthesized changes: the Google policy review ID, the new runtime roles and trust policies, the OAuth client and its callback, logout and scopes, product capabilities, caller IAM route permissions and the REST API resource policy. Review the `s3:ListBucket` grant the native bridge needs, and the fact that enabling an execution pair lets already-enrolled sessions continue under that worker without a new login. Deployment never seeds an organization or grants a human membership. After activation, verify a fresh Google login, account persistence, read isolation, member visibility and rejection paths against the deployed IAM and S3 before claiming it works.

### Granting a product to an account

Only a reviewed operator turns a product on or off for an account. The writable route is merged but unreachable until the directory BFF policy allows it, and no one holds the grant yet.

### Membership index

Listing a person's accounts used to read every canonical account document, with a hard limit of 256 accounts. Each active membership now also has a create-only marker at `members/<personId>/<accountId>.json`, written before the account document publishes. With `membershipLookup: "indexed"` in `accounts/deployment.json`, `GET /v1/accounts` and `GET /v1/account-directory` list only the person's markers and read only those accounts. Markers never grant anything: every candidate is checked against its account document, so a revoked membership or an account that never published is not listed. Revocation leaves the marker in place. The operator listing still reads every account.

Rollout, with each AWS step run from Ryan's Mac (the code is merged; the setting is still `scan`):

1. Deploy with `membershipLookup: "scan"` (the current setting). New accounts and memberships start writing markers; listings still use the full scan.
2. Build the bridge with S3 support (`PROSPECTUS_BUILD_IDENTITY_S3=true npm run build:identity-files`) and backfill markers for older accounts. Without `--write` the script only counts accounts and active memberships:
   `PROSPECTUS_ACCOUNTS_BUCKET=<bucket> PROSPECTUS_ACCOUNTS_OWNER=<account> node --import tsx scripts/rebuild-membership-index.ts`
   then with `PROSPECTUS_MEMBERSHIP_INDEX_APPROVAL=<account>/<bucket>` and `--write`. Rerunning it is harmless.
3. Change `membershipLookup` to `"indexed"` and deploy.

The runtime role already covers `prospectus-central/accounts/*`, which includes the markers, so no IAM change is needed.

### Product access

An account starts with only the product it was created from. An operator can grant or disable another registered product with `POST /v1/account-directory/operator/accounts/<accountId>/entitlements/<product>` and the body `{"status":"active"}` or `{"status":"disabled"}`. A grant gives the product its registered capabilities, which members still use only within their role. Disabling denies that product's authorize calls and keeps memberships and all account data. Each change is an `entitlement.changed` audit event under the same revision check as membership changes.

Only a person holding a reviewed `accounts:admin:entitlements` grant in `accounts/operator-grants.json` can call the route. Operator read access is not enough, and account owners cannot grant products to themselves. No such grant exists yet. The directory BFF's API Gateway policy still allows only `GET` on the account directory, so making the route reachable also needs that policy change, which is held for approval.

### Delivery

this repository is public, so CI runs on GitHub Actions (`.github/workflows/ci.yml`, on pull requests and pushes to `main`) and CD runs in AWS. Merging to `main` starts an Amplify build of the branch (`enableAutoBuild` in `infra/branch-settings.json`, `enableBranchAutoBuild` in `infra/hosting-settings.json`), which runs `amplify.yml`. Nobody starts builds by hand. The settings were `false` since the initial `papyrus-proof` source (b57ad68) with no recorded reason, so a proof app would not deploy on push.


### Login challenge signing secret

Login challenges are signed with a secret in SSM Parameter Store (`loginChallengeSigner` in `accounts/deployment.json`, kind `parameter-store`). CDK grants `ssm:GetParameter` on the parameter but cannot create a SecureString, so create it once before or after the deployment. Run on your Mac, with the `papyrus-production` profile; the command generates the secret and stores it without printing it:

```
aws ssm put-parameter --profile papyrus-production --region us-east-1 \
  --name /prospectus/central-accounts/login-challenge-mac/v1 \
  --type SecureString --value "$(openssl rand -base64 48)" --no-overwrite
```

The default `alias/aws/ssm` key encrypts it. Until the parameter exists, challenge requests return 503 and sign-in falls back to a plain Google login (no outage, only the second Accounts confirmation on the Accounts tab); failed reads are not cached, so signed challenges start working as soon as the parameter exists.

Rotation: create `/prospectus/central-accounts/login-challenge-mac/v2` with the same command, set `currentKeyId` to `v2` and `previousKeyId` to `v1` in `accounts/deployment.json`, review and merge, and after at least 5 minutes remove `previousKeyId`. Delete the old parameter afterwards with `aws ssm delete-parameter`. Never paste the value into a ticket, chat or commit.

## Verification

Run from the repository root after building the pinned Kanbus UI (see [README.md](../README.md#development)):

| Command | Covers |
| --- | --- |
| `npm run lint` | Prettier check of all TypeScript, TSX, MJS and JS |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Frontend, client, auth, intake and the real-RSA Google identity cases |
| `npm run build` | Typecheck and production frontend build |
| `npm run build:identity-files` | The pinned native bridge (Rust, several minutes) |
| `npm run test:accounts:durable` | Durable accounts, the directory and execution delegation against real Virtuus files |
| `npm run test:accounts:delegation` | Execution delegation only |
| `node --import tsx --test accounts/durable-google-identities.test.ts` | Identity crash, restart and concurrency cases |
| `npm run test:intake`, `npm run test:intake:integration` | Intake rules, and the actual local API with disposable synthetic data |
| `npm run test:control-binding` | Conditional control writes and deterministic S3 fault cases |
| `PROSPECTUS_ACCOUNTS_UI=1 node --import tsx --test test/accounts-directory-ui.test.ts test/accounts-persisted-ui.test.ts` | Browser states and persisted account data |
| `npm run test:e2e` | Playwright browser acceptance; needs a real local API and `PROSPECTUS_TEST_TOKEN` |
| `npm ci --prefix infra && npm run check --prefix infra` | Types, tests and synthesis of the CDK app, including that existing CRM resources are identical with Accounts enabled |
| `npm run check:amplify --prefix infra` | The Amplify Gen2 entry |
| `npm run synth:amplify-review --prefix infra`, `npm run synth:accounts:review --prefix infra` | Offline synthesis of the actual Gen2 assembly with Accounts enabled |
| `bash scripts/build-accounts-linux.sh` then `node accounts/package-smoke.mjs` | Linux x86_64 native bridge and Node 24 handler packaging, checked without credentials |

`.github/workflows/ci.yml` runs the application and infrastructure checks on pushes to `develop` and `main` and on pull requests. When `accounts/deployment.json` is enabled it also runs the package smoke test and the persisted isolation suites. Set `PROSPECTUS_PACKAGE_NODE_MAJOR=24` to check the exact Lambda Node major. Tests use synthetic RSA identities, disposable roots and no cloud credentials; they do not prove deployed SigV4 enforcement, real Google login or real S3 behavior.

Local previews and proofs use only synthetic data: `npm run preview:local` for loopback, `npm run preview:lan` for an explicitly chosen private network.

## Rollback

- Frontend: redeploy a prior commit through the Amplify `main` pipeline. Commit `13155d7` is the recorded earlier central checkpoint. Keep accepted data and intake control objects when rolling back application code.
- Intake: set `enabled` to `false` in `evaluation-deployment.json`. This removes the additive route and output and restores the prior frontend. Accepted records and shared controls are preserved and not purged. Intake claims must survive rollback and catalog rebuild.
- Accounts: set `enabled` to `false` in `accounts/deployment.json`; canonical account and identity files remain in S3. Removing an operator grant or a site entry denies that principal on the next deployment without touching memberships.
- Never use old proof branches or DNS setup artifacts to recreate a second CRM.

## Tracking and process

- Work is tracked in Kanbus under `project/`. Preserve issue IDs and change state with Kanbus commands.
- Write behavior specifications (`.feature` files) before implementation and verify real API persistence, authorization and revision conflicts.
- Use isolated branches and pull requests; merge into `main` only with direction.
- Code style: Prettier formatting, no comments that restate a line, long descriptive names, no single-letter identifiers.

## Appendix: proof history

Dated reports from the work that built the current system. They are history, not guarantees about today's code; rerun the commands above for current evidence.

- **2026-10-14, local CRM persistence.** Two Playwright tests passed against the filesystem-backed Kanbus REST API with the compiled shared UI. They covered anonymous requests returning 401, creating a synthetic prospect with a follow-up date, due follow-ups, advancing through new, contacted, qualified, proposal and customer, handing ownership to customer success with a note, and reload persistence of issue ID, owner, email and note. The executable proof is `test/browser/prospectus.spec.ts`. This did not establish deployed Cognito acceptance.
- **Central deployment acceptance.** Google sign-in and staff access were accepted at prospectus.anth.us with the previous checkpoint `13155d7`. The inquiry MVP reconciliation began at `5eebfb5` with reliability checkpoints `9ed6ef6` and `36d148d`.
- **2026-10-15, identity and accounts, local.** The durable identity suite (crash and restart at every enrollment phase, eight-process convergence, conflicting aliases, expired proofs, pending and conflicting enrollment with no side effects, canonical-copy reconstruction) and the durable account suite (concurrent identical creates, conflicting owner demotions, stale actor revocation, entitlement disablement, many-to-many membership, bounded audit, malformed data denial) passed against real Virtuus files, including a restart of the JSON-lines central process. Native S3 behavior was exercised only against a loopback fake.
- **2026-10-15, console integration.** The Cyclotron console owner reported its real Python BFF and SigV4 client passing against the central harness (commit `785ebf8` on its branch): the same Google subject in two pools resolves one Person, account create replay keeps the ID, changed input is refused, viewers stay read-only after restart, revocation survives restarts, and another product lacks the entitlement. This was synthetic local evidence, not deployed IAM or real Google login.
- **Review IDs dated 2026-10-15.** The checked-in Accounts activation uses Google policy review `papyrus-google-only-unlinked-v1-20261015`, the Cyclotron client and role pair use `cyclotron-google-only-unlinked-v1-20261015` and `cyclotron-execution-pair-v1-20261015`, and the first operator read grant is `accounts-admin-read-approved-20261015`.
- **2026-10-17.** Real-contact intake for the anth.us engage page was approved with privacy notice `contact-v1`, inquiries kept until the person asks for deletion, owner `intake-queue`.
