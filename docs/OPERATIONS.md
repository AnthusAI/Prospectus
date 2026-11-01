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
- Deployment is only through the Amplify `main` pipeline. There is no manual content sync and no separate branch deployment. Work integrates on `develop`; promoting `develop` to `main` is the release (see [AGENTS.md](../AGENTS.md#git-workflow)).

## Deployment

`amplify.yml` runs the backend pipeline: verify scope, check out the pinned Kanbus sources, build the shared UI, `npm ci`, typecheck, test, package the Linux Kanbus API, build the intake bundle when enabled, build the Accounts bundles, run the infrastructure checks and `ampx pipeline-deploy`. The frontend phase writes `.env.production.local` from the Amplify outputs (`infra/scripts/write-frontend-env.mjs`) and runs `npm run build`. When `infra/portal-hosting.json` is enabled, the backend phase also builds `dist-portal` (`infra/scripts/build-portal-if-enabled.mjs`) before `ampx pipeline-deploy`, which publishes it to the portal bucket and invalidates CloudFront (see [accounts/ANTHUS_ONE_PORTAL.md](accounts/ANTHUS_ONE_PORTAL.md#hosting)). Keep the reviewed pinned Node build image and `infra/hosting-settings.json`, including the single-page-app rewrite and disabled legacy CLI overrides. The `/cli/<*>` rewrite for remote CLI sign-in is not in that file: the backend owns it (see [ARCHITECTURE.md](ARCHITECTURE.md#remote-cli-sign-in-cli-login)), so re-applying the file by hand removes it.

### Local development against the deployed backend

`npm run dev:cloud` runs the working tree locally with real Google sign-in, the deployed API and the accounts service, and nothing is deployed. It reads the `main` branch's outputs once with `ampx generate outputs` (run `aws login` for papyrus-production first; refresh with `npm run dev:cloud -- --refresh`), caches them in the ignored `.build/cloud/`, and starts Vite at http://localhost:5417. The data is production data, so edits are real.

`http://localhost:5417` is in `APP_ORIGINS` (`infra/lib/scope.ts`), so the Cognito client's callback and logout URLs, the API's CORS origins and the accounts service's POST origin check accept it beside the production address. Cognito permits plain http only for localhost, so open `localhost`, not `127.0.0.1`. Google itself is unchanged: its OAuth client only ever redirects to the Cognito domain.

`npm run dev:portal` does the same for the Anthus One customer portal at http://localhost:5421 (`one.anth.us` itself is hosted by the CDK stack, never by a second Amplify app or a manual upload). It signs in with Google directly (no Cognito). The production Google client authorizes only `https://one.anth.us`, so local portal work needs a separate development Google client (Authorized JavaScript origins `http://localhost:5421` and `http://localhost`), passed as `ANTHUS_ONE_DEV_GOOGLE_CLIENT_ID`; Vite forwards `/api` to the portal API from the `AnthusOneBffUrl` output with the origin `https://one.anth.us`. The deployed API verifies only the production client as audience, so a development-client token is refused (`401`) until a development backend exists; creating the client and that backend is tracked in kanbus-1b54c9.

To try the app from a tablet or phone on the same network, `npm run dev:cloud -- --lan <host>` serves it over HTTPS at https://<host>:5418 (Cognito accepts plain http only for localhost, so a network address needs HTTPS and a name, and that origin must be in `APP_ORIGINS`). One-time setup on the developer's Mac: point `<host>` at the Mac's network address in the `anth.us` Route 53 zone (an A record to a private address, so it only works on that network), and issue a certificate into the ignored `.build/lan-certs/` with `lego run --accept-tos --dns route53 --domains <host> --path .build/lan-certs` (`AWS_PROFILE=papyrus-production`, `AWS_HOSTED_ZONE_ID` set to the `anth.us` zone). Let's Encrypt certificates last 90 days; rerun with `lego renew` to renew. Update the A record if the Mac's address changes.

`npm run preview:local` remains the fully offline option with synthetic data and a local token.

The Kanbus API, the shared UI package and Virtuus are pinned independently in `source-lock.json`, so a UI-only release cannot replace the deployed API. `.github/workflows/package-backend.yml` builds a reviewed backend package on demand.

Do not rewrite canonical paths or delete data in a UI release.

### Anthus One portal sign-in

Google Cloud console, project "Anthus One", OAuth client `712526614578-dp3o0ofrukf7h2qcjst345t033mi990c`:

- Authorized JavaScript origins: `https://one.anth.us` only. No localhost origin on the production client; local development uses a separate development client (kanbus-1b54c9).
- Authorized redirect URIs: none are needed. The Cognito `idpresponse` URI registered earlier can be removed.
- OAuth consent screen: publishing status "In production" (or test users listed), scopes `openid`, `email`, `profile` only.
- The client secret is not used anywhere and the Secrets Manager secret `anthus-one/oauth/google` can be deleted.

Two-step rollout: (1) merge and deploy the backend; read the `AnthusOneBffUrl` deploy output (also in the Amplify outputs for `main`). (2) Record it as `signIn.accountsBffUrl` in `infra/portal-app.json` (it must look like `https://<id>.execute-api.us-east-1.amazonaws.com/api/saas`) and merge; the portal build reads it through `infra/scripts/write-portal-env.mjs`. Until then the portal builds and says the account service is not configured. No CRM resource, client or origin is involved.

### Activation flags

Each additive slice is switched by a checked-in file that the pipeline reads. Changing a flag is a reviewed source change that deploys on merge.

| File | Controls | Value on this branch |
| --- | --- | --- |
| `infra/portal-hosting.json` | Anthus One hosting at `one.anth.us`: private bucket, CloudFront, certificate, DNS and publication of `dist-portal`; new persistent resources, so it needs concrete approval before it is set to true | `enabled: false` |
| `accounts/deployment.json` | Central Accounts plane; needs `storageMode` `canonical-virtuus-v1` and a Google policy review ID | `enabled: true`, review `papyrus-google-only-unlinked-v1-20261015` |
| `accounts/console-deployment.json` | Cyclotron console Cognito client (`clientEnabled`) and its BFF and worker role pair (`pairEnabled`); the pair requires the client | both `true` |
| `accounts/deployment.json` `accountCreationLimits` | Most accounts one Person may create per product (`default`, or a product name); creating more returns `409 account_limit`, and "contact us" is the path to more. Replays of an existing request key do not count | `{"default": 3}` |
| `accounts/anthus-one-deployment.json` | The Anthus One portal API, role, Lambda and `anthus-one` product (Google-direct); names the public Google client and reviewed policy `anthus-one-google-direct-v1-20261020` | `enabled: true` |
| `accounts/papyrus-sites.json` | Registered Papyrus sites, at most 40 | empty |
| `accounts/lab-verifier.json` | The Cyclotron lab verifier: the external role `cyclotron-lab-verifier` (created by Cyclotron in its own account) and one Allow in the API access policy for two routes; it trusts the sites in `accounts/papyrus-sites.json` and needs at least one. Enable only after Cyclotron has deployed the role and Ryan has approved the synthesized policy change | `enabled: false` |
| `accounts/operator-grants.json` | Operators who may read the whole directory | one reviewed grant |
| `infra/cli-sign-in.json` | Remote CLI sign-in (see [ARCHITECTURE.md](ARCHITECTURE.md#remote-cli-sign-in-cli-login)): the pages Lambda `prospectus-cli-pages`, its four `/cli/*` routes and the `/cli/<*>` rewrite on the Amplify app. `broker: null` deploys the pages unconfigured (`503`); the broker's function ARN and URL are committed only after its stack is approved and deployed | `enabled: true`, `broker: null` (step 1) |
| `evaluation-deployment.json` | Inquiry intake runtime, its mode (`synthetic-only` or `real-contacts`) and `spamLabelling` (`shadow` or `label`, see [INTAKE_SPAM.md](INTAKE_SPAM.md)) | `enabled: false`, `synthetic-only` here; `main` carries `enabled: true`, `real-contacts` since the engage-page change |
| `intake-forms.json` | App waitlist and contact forms (see [ARCHITECTURE.md](ARCHITECTURE.md#integrating-an-apps-waitlist) and [the contact form](ARCHITECTURE.md#integrating-an-apps-contact-form)); a form needs `enabled: true` plus a recorded `approval`, and the `real-contacts` runtime | `babulus-waitlist-v1` is `enabled: true` for `https://babulus.anth.us` only (Ryan approved 2026-10-20, recorded in the entry); it collects real contacts once deployed, and acceptance is a labelled test signup after deploy. `papyrus-waitlist-v1` and `papyrus-contact-v1` are `enabled: true` for `https://p.apyr.us` only (Ryan approved 2026-10-21, recorded in each entry); enabling them adds, per form, one route, one Lambda integration and permission, one route throttle and the `https://p.apyr.us` CORS origin, and the `IntakeContactBaseUrl` output once. Acceptance is a labelled test message after deploy. `papyrus-newsletter-v1` is `enabled: true` for `https://p.apyr.us` only (Ryan approved 2026-10-21, recorded in the entry); enabling it adds its signup route, the confirm and unsubscribe page routes, the SES identity, configuration set, DNS records and token key in [Newsletter sending](#newsletter-sending), and the `IntakeNewsletterBaseUrl` output. Acceptance is a labelled test signup after deploy and SES production access |

Whether a flag is deployed is a fact about the cloud account, not the repository. Check the Amplify build history before claiming an activation is live. The anth.us engage form is not a working Prospectus intake until the intake runtime is deployed and the public form's endpoint and privacy notice settings in AnthusAI/Anth.us-Papyrus point at the `EvaluationIntakeUrl` output.

### Known manual hosting

The CRM frontend is served by the Amplify app `d15sc1sptohtqb`, which was created by hand with a GitHub connection. That conflicts with the rule that nothing is manually configured; bringing it under infrastructure as code is tracked in Kanbus `kanbus-e72209` (do not recreate the app or break the `prospectus.anth.us` domain in the meantime).

### Turning on a Papyrus site

Follow [accounts/PAPYRUS_SITES.md](accounts/PAPYRUS_SITES.md). The registry entry only exposes the site's read routes; the site's own runtime role also needs `execute-api:Invoke` on the same routes in its own account. Site cutover tracking is Kanbus `kanbus-2755969c` with Papyrus `PPY-58f107`.

### Enabling or changing the Accounts plane

Before changing `enabled` or any role pair, get action-time approval for the exact synthesized changes: the Google policy review ID, the new runtime roles and trust policies, the OAuth client and its callback, logout and scopes, product capabilities, caller IAM route permissions and the REST API resource policy. Review the `s3:ListBucket` grant the native bridge needs, and the fact that enabling an execution pair lets already-enrolled sessions continue under that worker without a new login. Deployment never seeds an account or grants a human membership. After activation, verify a fresh Google login, account persistence, read isolation, member visibility and rejection paths against the deployed IAM and S3 before claiming it works.

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

this repository is public, so CI runs on GitHub Actions (`.github/workflows/ci.yml`, on pull requests and pushes to `develop` and `main`) and CD runs in AWS. Pull requests merge to `develop`, the integration branch; a push to `develop` runs CI and deploys nothing. Since 2026-10-31 (Ryan: Amplify builds only deploy, CI runs in GitHub Actions) merging to `main`, normally the `develop` to `main` promotion, deploys once, after green CI: the `deploy` job in `ci.yml` assumes the `prospectus-github-deploy` role through GitHub OIDC (`infra/github-deploy/prospectus-github-deploy-role.template.yaml`, which may only `amplify:StartJob` and `amplify:GetJob` on this app's `main` jobs) and starts one Amplify release job for that commit, which runs `amplify.yml`. Amplify's own auto-build on `main` is off (`enableAutoBuild: false` in `infra/branch-settings.json`), so nothing builds twice and a red CI run deploys nothing. The shared deploy workflow is pinned to a reviewed Papyrus commit. Nobody starts builds by hand. The settings were `false` since the initial `papyrus-proof` source (b57ad68) with no recorded reason, so a proof app would not deploy on push.


### Login challenge signing secret

Login challenges are signed with a secret in SSM Parameter Store (`loginChallengeSigner` in `accounts/deployment.json`, kind `parameter-store`). CDK grants `ssm:GetParameter` on the parameter but cannot create a SecureString, so create it once before or after the deployment. Run on your Mac, with the `papyrus-production` profile; the command generates the secret and stores it without printing it:

```
aws ssm put-parameter --profile papyrus-production --region us-east-1 \
  --name /prospectus/central-accounts/login-challenge-mac/v1 \
  --type SecureString --value "$(openssl rand -base64 48)" --no-overwrite
```

The default `alias/aws/ssm` key encrypts it. Until the parameter exists, challenge requests return 503 and sign-in falls back to a plain Google login (no outage, only the second Accounts confirmation on the Accounts tab); failed reads are not cached, so signed challenges start working as soon as the parameter exists.

Rotation: create `/prospectus/central-accounts/login-challenge-mac/v2` with the same command, set `currentKeyId` to `v2` and `previousKeyId` to `v1` in `accounts/deployment.json`, review and merge, and after at least 5 minutes remove `previousKeyId`. Delete the old parameter afterwards with `aws ssm delete-parameter`. Never paste the value into a ticket, chat or commit.

### Site subject secret

Public-reader Papyrus sites receive pairwise site subjects derived with an HMAC secret held in the SSM SecureString `/prospectus/central-accounts/site-subject/v1` (`siteSubjectSecret` in `accounts/deployment.json`). Nothing is configured by hand: the normal deployment creates it once with the create-only custom resource `Custom::ProspectusSiteSubjectSecret`, whose Lambda (`prospectus-site-subject-secret-init`) generates 48 random bytes and stores them with `Overwrite: false`. If the parameter already exists it is left as it is. Updates and stack deletion never change or remove it.

Until the parameter exists, or whenever it cannot be read, public-reader sites get `503` on every identity call; editor sites, the CRM and Anthus One are unaffected. Failed reads are not cached, so readers recover as soon as the parameter is readable. Check that it exists without printing it:

```bash
aws ssm describe-parameters --profile papyrus-production --region us-east-1 \
  --parameter-filters Key=Name,Values=/prospectus/central-accounts/site-subject/v1
```

Never rotate, overwrite or remove this parameter. Every reader site keys its readers on the subjects it produces; a new value would turn every reader into a stranger and orphan their data. If it must ever change (for example after a suspected disclosure), that is a planned migration to a `v2` secret with `ss2_` subjects, run together with each reader site, not a rotation. Never paste the value into a ticket, chat or commit. If the parameter is lost, only the same value restores the subjects; a regenerated value is a new secret.

### Newsletter sending

Everything is created by the normal deployment when a newsletter entry is enabled (`infra/lib/newsletter-mail.ts`); nothing is configured by hand except the one SES production-access request below, which AWS does not offer as infrastructure as code.

| Resource | Name | Monthly cost |
| --- | --- | --- |
| SES domain identity, Easy DKIM 2048-bit, custom MAIL FROM | `news.apyr.us`, MAIL FROM `bounce.news.apyr.us` | Free |
| SES configuration set (bounce and complaint suppression, reputation metrics) | `prospectus-newsletter` | Free |
| SES sending | confirmation emails now; campaigns later | $0.10 per 1,000 emails (well under $1 at expected volume) |
| Route 53 records in the existing `apyr.us` zone (`Z0630882HVOV46S7IPV7`) | 3 DKIM CNAMEs, MX and SPF TXT on `bounce.news.apyr.us`, DMARC TXT on `_dmarc.news.apyr.us` | Free (no new zone; queries are cents at most) |
| SSM SecureString (standard tier, `aws/ssm` key) | `/prospectus/newsletter/token-signing/v1` | Free; KMS decrypts are cached per Lambda instance (cents at most) |
| Create-only initializer Lambda, role and log group (one month retention) | `prospectus-newsletter-token-init` | Free (runs once per deploy) |
| API routes and throttles on the existing intake API | signup, confirm and unsubscribe | $1 per million requests (effectively free) |

`news.apyr.us` is a sending-only subdomain: list reputation, bounces and DMARC results stay off `apyr.us` and off `p.apyr.us`, which receives mail through SES inbound. DMARC starts at `p=none` with no report address, because none exists; adding `rua=` (and later `p=quarantine`) is a reviewed change once a reporting mailbox exists.

**After the deploy** (read only, from your Mac):

```bash
# DKIM and MAIL FROM: both must reach SUCCESS (DNS is in the same stack, usually within an hour)
aws sesv2 get-email-identity --profile papyrus-production --region us-east-1 \
  --email-identity news.apyr.us \
  --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus,configurationSet:ConfigurationSetName}'
aws sesv2 get-configuration-set --profile papyrus-production --region us-east-1 \
  --configuration-set-name prospectus-newsletter --query SuppressionOptions
aws ssm describe-parameters --profile papyrus-production --region us-east-1 \
  --parameter-filters Key=Name,Values=/prospectus/newsletter/token-signing/v1 --query 'Parameters[].Name'
dig +short MX bounce.news.apyr.us; dig +short TXT bounce.news.apyr.us; dig +short TXT _dmarc.news.apyr.us
```

**SES production access.** The account's SES is in the sandbox (200 emails a day, verified recipients only), so a confirmation to an ordinary address fails until production access is granted. The signup is still stored and answered 202 with the send marked `send_failed`, but the person gets no email and must sign up again later, so p.apyr.us should not turn its form on until access is granted. Request it once the identity shows DKIM `SUCCESS` (Ryan approves and runs it, or has it run):

```bash
aws sesv2 put-account-details --profile papyrus-production --region us-east-1 \
  --production-access-enabled \
  --mail-type MARKETING \
  --website-url https://p.apyr.us/ \
  --contact-language EN \
  --use-case-description "$(cat <<'TEXT'
Anthus sends a low-volume, opt-in newsletter for Papyrus (https://p.apyr.us/) from the dedicated subdomain news.apyr.us. People subscribe only on our own website, and every subscription is double opt-in: we send exactly one confirmation email, limited to one per address per 24 hours, and nothing else is sent until the person clicks the signed confirmation link (valid 7 days). Signups that fill our honeypot field or score as likely spam get no email. Every email carries List-Unsubscribe and List-Unsubscribe-Post (RFC 8058) one-click headers and a visible unsubscribe link; an unsubscribe is permanent. We send through a configuration set whose suppression options put bounces and complaints on the account-level suppression list, so those addresses are never mailed again. The domain uses Easy DKIM (2048-bit), a custom MAIL FROM domain with SPF, and DMARC. We never buy, rent or import lists. Expected volume is under 1,000 emails a month at first: one newsletter about monthly plus confirmation emails.
TEXT
)"
```

AWS answers by support case, usually within a day, and may ask follow-up questions. Check the result with `aws sesv2 get-account --profile papyrus-production --region us-east-1 --query ProductionAccessEnabled`. Testing before then needs a verified recipient (`aws sesv2 create-email-identity --email-identity <your address>` and the link in the verification email, then deleting that identity afterwards); Ryan chose not to test in the sandbox, so acceptance is a labelled signup from p.apyr.us after production access.

<a id="newsletter-export"></a>**Export of confirmed subscribers.** Run with your own credentials; it only lists and reads the `intake-newsletter/` prefix and the SES account suppression list. Without `--output` it prints counts per list and status only:

```bash
AWS_PROFILE=papyrus-production PROSPECTUS_NEWSLETTER_BUCKET=prospectus-records-712236451410 \
  node --import tsx scripts/export-newsletter-subscribers.ts
AWS_PROFILE=papyrus-production PROSPECTUS_NEWSLETTER_BUCKET=prospectus-records-712236451410 \
  node --import tsx scripts/export-newsletter-subscribers.ts --list papyrus-newsletter-v1 --output ~/papyrus-subscribers.csv
```

The CSV (created new, mode 600) holds confirmed subscribers who have not unsubscribed and are not on the SES suppression list, with their confirmation time, notice version, request time and source page. It is personal data: keep it off shared drives and delete it after use. Campaign sending is not built; its rules are in [ARCHITECTURE.md](ARCHITECTURE.md#newsletter-mailing-lists).

**Deletion requests.** Delete the subscription object for the address (its key is the hash in `NewsletterService.subscriptionHash`) and the prospect's `custom.newsletters` entry; leave the suppression object, which holds no address, so the address is still never mailed.

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
| `npm run synth:amplify-review --prefix infra`, `npm run synth:accounts:review --prefix infra`, `npm run synth:portal:review --prefix infra` | Offline synthesis of the actual Gen2 assembly with Accounts enabled, and with Anthus One hosting enabled |
| `bash scripts/build-accounts-linux.sh` then `node accounts/package-smoke.mjs` | Linux x86_64 native bridge and Node 24 handler packaging, checked without credentials |

`.github/workflows/ci.yml` runs the application and infrastructure checks on pushes to `develop` and `main` and on pull requests. When `accounts/deployment.json` is enabled it also runs the package smoke test and the persisted isolation suites. Set `PROSPECTUS_PACKAGE_NODE_MAJOR=24` to check the exact Lambda Node major. Tests use synthetic RSA identities, disposable roots and no cloud credentials; they do not prove deployed SigV4 enforcement, real Google login or real S3 behavior.

Local previews and proofs use only synthetic data: `npm run preview:local` for loopback, `npm run preview:lan` for an explicitly chosen private network.

## Rollback

- Frontend: redeploy a prior commit through the Amplify `main` pipeline. Commit `13155d7` is the recorded earlier central checkpoint. Keep accepted data and intake control objects when rolling back application code.
- Intake spam labelling: set `spamLabelling` back to `shadow` in `evaluation-deployment.json`. Stored spam results and existing labels stay; new likely spam is scored but not labelled.
- Intake: set `enabled` to `false` in `evaluation-deployment.json`. This removes the additive route and output and restores the prior frontend. Accepted records and shared controls are preserved and not purged. Intake claims must survive rollback and catalog rebuild.
- Accounts: set `enabled` to `false` in `accounts/deployment.json`; canonical account and identity files remain in S3. Removing an operator grant or a site entry denies that principal on the next deployment without touching memberships.
- Never use old proof branches or DNS setup artifacts to recreate a second CRM.

## Tracking and process

- Work is tracked in Kanbus under `project/`. Preserve issue IDs and change state with Kanbus commands.
- Write behavior specifications (`.feature` files) before implementation and verify real API persistence, authorization and revision conflicts.
- Use isolated branches and pull requests to `develop`; promote `develop` to `main` only with direction.
- Code style: Prettier formatting, no comments that restate a line, long descriptive names, no single-letter identifiers.

## Appendix: proof history

Dated reports from the work that built the current system. They are history, not guarantees about today's code; rerun the commands above for current evidence.

- **2026-10-14, local CRM persistence.** Two Playwright tests passed against the filesystem-backed Kanbus REST API with the compiled shared UI. They covered anonymous requests returning 401, creating a synthetic prospect with a follow-up date, due follow-ups, advancing through new, contacted, qualified, proposal and customer, handing ownership to customer success with a note, and reload persistence of issue ID, owner, email and note. The executable proof is `test/browser/prospectus.spec.ts`. This did not establish deployed Cognito acceptance.
- **Central deployment acceptance.** Google sign-in and staff access were accepted at prospectus.anth.us with the previous checkpoint `13155d7`. The inquiry MVP reconciliation began at `5eebfb5` with reliability checkpoints `9ed6ef6` and `36d148d`.
- **2026-10-15, identity and accounts, local.** The durable identity suite (crash and restart at every enrollment phase, eight-process convergence, conflicting aliases, expired proofs, pending and conflicting enrollment with no side effects, canonical-copy reconstruction) and the durable account suite (concurrent identical creates, conflicting owner demotions, stale actor revocation, entitlement disablement, many-to-many membership, bounded audit, malformed data denial) passed against real Virtuus files, including a restart of the JSON-lines central process. Native S3 behavior was exercised only against a loopback fake.
- **2026-10-15, console integration.** The Cyclotron console owner reported its real Python BFF and SigV4 client passing against the central harness (commit `785ebf8` on its branch): the same Google subject in two pools resolves one Person, account create replay keeps the ID, changed input is refused, viewers stay read-only after restart, revocation survives restarts, and another product lacks the entitlement. This was synthetic local evidence, not deployed IAM or real Google login.
- **Review IDs dated 2026-10-15.** The checked-in Accounts activation uses Google policy review `papyrus-google-only-unlinked-v1-20261015`, the Cyclotron client and role pair use `cyclotron-google-only-unlinked-v1-20261015` and `cyclotron-execution-pair-v1-20261015`, and the first operator read grant is `accounts-admin-read-approved-20261015`.
- **2026-10-17.** Real-contact intake for the anth.us engage page was approved with privacy notice `contact-v1`, inquiries kept until the person asks for deletion, owner `intake-queue`.
