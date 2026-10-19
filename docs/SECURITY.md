# Security

The repository is public and MIT licensed; the deployed CRM and account service are private. Never commit real customer records, credentials, tokens, subjects or email addresses of real people. Keep deployment credentials in the approved platform configuration.

## Principals and authentication

| Surface | Who can call | How it is checked |
| --- | --- | --- |
| CRM Kanbus API (`/api/{proxy+}`) | Invited staff | Cognito JWT from the Google-only browser client, then membership in the `prospectus-members` group |
| Accounts BFF (`/api/saas/*`) | Any signed-in person | Same JWT authorizer; the BFF verifies the token again and signs central requests itself |
| Central accounts service | Registered product roles only | IAM SigV4, an API Gateway resource policy that allows each named role only its routes, and a deny for every other principal |
| Inquiry intake (`POST /intake/demo`) | The public, from allowed origins | Origin and notice checks, throttling and a fixed intake actor; no read access |

Signing in alone grants no CRM staff access, no account membership and no product entitlement.

### Cognito

Self sign-up is disabled. The CRM and Cyclotron browser clients support only the Google identity provider; the password, SRP, custom and client-credentials flows are off, implicit grant is off, authorization code is on, and token revocation is enabled. Access and ID tokens last one hour and refresh tokens 30 days. The pool has deletion protection and a retain removal policy.

### Google sign-in secret

The Google OAuth client ID and secret come from the AWS Secrets Manager secret `prospectus/proof/oauth/google`, read by the CDK stack in `infra/lib/prospectus-backend.ts`. This secret is live in the papyrus-production account and is the one Prospectus uses. A copy that existed in the cyclotron-production account was unused and has since been deleted; because nothing referenced it, the deletion is not a deploy risk. Do not copy the secret into the repository, a pipeline variable or a log. Each Papyrus site has its own Google project and OAuth client for its own sign-in; Prospectus does not hold those.

## Account authorization rules

- Every account read and write checks the caller's active membership, role, the product's registered capability and the account's entitlement for that product. Knowing a Person or account ID grants nothing.
- Viewers and revoked members cannot write. Writes by unsupported products and by unknown or pending Persons are refused before any canonical mutation.
- Concurrent membership changes use revision compare-and-set on the whole account document and recheck the actor. The last owner cannot be removed and a revoked actor cannot publish a stale change.
- Owners and admins with account-scoped `members:read` see an account's membership list; members and viewers see only their own membership.
- Apps own permissions on their own objects, keyed by Prospectus person and account IDs, and never exceed the Prospectus role. Cross-app roles are added to Prospectus.
- Product entitlements are changed only by reviewed operators, not by account owners.
- Request JSON cannot supply a grant, identity or role. Unknown fields are rejected.

### Operator access

`accounts/operator-grants.json` is the deployment-owned list of operators allowed to read the whole central directory. Each grant names exactly one registered product, a Cognito issuer, the SHA-256 digest of the verified subject, the permission `accounts:admin:read`, and a reviewed approval ID. The raw subject and email are never stored in the public source. Grants are validated at startup and copied to prevent mutation. Email addresses and the CRM `admin` group are never permission sources. The canonical Person and a current, nonce-confirmed Google session must still resolve before any operator read, and the existing issuer, client, subject, nonce, authentication age and login-family checks still apply.

Operator access does not create a membership, enable a product, authorize CRM use or allow a mutation. The operator routes are read-only and return no-store responses. Removing a grant denies the operator's next request without editing any membership. Before adding a grant, have the operator confirm their exact Google profile privately, review the verified issuer and subject mapping, and record explicit approval to read all organizations, entitlements and memberships. Never infer the operator from an email address or CRM role.

## Identity evidence

Central verification of Google-backed sign-in requires, for both the access and ID token: RS256 signature against the registered issuer's keys, exact `iss`, token purpose, `exp`, `iat` and `nbf`; ID `aud` equal to access `client_id` and to the single registered federation client; matching pool `sub`, `auth_time` and a non-empty `origin_jti`; authentication at most 300 seconds old and future skew at most 30 seconds; the ID nonce matching the unexpired challenge. The ID token must contain exactly one identity whose provider is the built-in Google provider with a bounded case-sensitive `userId`. Array order, `primary`, username and email never select the identity. Tokens are not logged or stored; challenge receipts keep only a digest of the token pair and the Person result.

A product registration with no `googleFederation` policy is denied the identity routes. The declaration is an operational approval input, not an inspection of AWS settings, so a reviewed policy ID must be re-reviewed when any of these change: the Google provider and client, Google-only client login, disabled alternative login paths, absence of linked profiles, administrator linking and pre-token customization, callback and logout URLs, and nonce, PKCE and state handling.

The pre-sign-in route `POST /api/saas/identity/login-challenge` is the only BFF route without a JWT authorizer. It requires the exact configured `Origin`, accepts only a 64-character lowercase hexadecimal `loginStateDigest`, reads no account data and is throttled by API Gateway (1 request per second, burst 2, for all callers together, so it can be exhausted; sign-in then falls back to a plain login). Each call writes a pending challenge file to the identity prefix of the canonical bucket. Those files are not expired automatically.

Error contract: `400` malformed input or raw authority fields, `401` invalid token, session or nonce or an expired challenge, `403` wrong caller, product, client or policy, `409` consumed challenge with changed proof or an identity mapping conflict, `429` capacity, `503` repository unavailable.

## Data handling

- The S3 bucket is private, versioned, TLS only and retained on stack deletion. Releases never rewrite or delete canonical paths.
- The central accounts runtime role may `GetObject` and `PutObject` only under the four `prospectus-central/` scopes listed in [ARCHITECTURE.md](ARCHITECTURE.md#storage), plus bucket-level `s3:ListBucket` limited by a `StringLike s3:prefix` condition to those same four scopes. It has no delete, DynamoDB, Cognito management or deploy rights.
- The intake runtime may invoke only `prospectus-api` and read and write only the intake identity and receipt prefixes. It has no listing, deletion, catalog, Cognito, Secrets Manager or IAM rights, and request bodies and contact data are not logged.
- The Kanbus runtime role is limited to the CRM namespace prefixes and to catalog rows whose leading key is that namespace.
- No persistent access keys exist. Runtime credentials come from Lambda roles.
- Server-only SigV4 code lives in `server/` and `@anthus/prospectus-accounts-client/server`; never import it into a browser bundle, and never forward an arbitrary browser token in place of a verified session.
- Real inquiry contacts are kept until the person asks for deletion (approved 2026-10-17 with privacy notice `contact-v1`). Tests and previews use only made-up data and `.invalid` addresses.

## Known limits

- Local JWT verification does not consult Cognito revocation state, so central token-family revocation is not immediate. Sessions in each BFF must invalidate their own server session on logout, and production must choose revocation and maximum-session-age behavior explicitly.
- A compromised Cognito pool administrator can undermine its assertions.
- An identity execution claim interrupted before canonical publication stays denied until an operator reconciles it; no automatic reset exists because a late native S3 request could still arrive.
- Account discovery scans up to 256 account documents per request and fails with `503` beyond that. Larger installations need a designed index and pagination.
- Per-person account quota is not enforced. Audit entries are capped at 128 per account with no rollover.
- Identity enrollment is a recoverable multi-file protocol, not an atomic S3 transaction. Imports and edits to canonical identity files must be quiescent.
- A profile with several identities needs an explicit linking flow that does not exist; directory-backed legacy linking is denied.
- Intake uniqueness holds only among intake writers; manual creation and import do not take intake claims.
- Tests cover process crashes and restarts, not disk or power loss or real S3 failure modes.

## Change control

New persistent IAM or security resources, OAuth client or callback changes, and new operator grants need concrete approval before they are deployed. Pin Kanbus and Virtuus revisions; never deploy from a moving dependency branch.
