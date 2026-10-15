# Reviewed execution principal continuation

This is an opt-in server registration contract. It does not activate a product,
create a runtime role, change OAuth, or grant API invocation. Registrations with
no `executionDelegation` retain their existing behavior, including the directory.

## Binding and authority

Each product still has one enrolling `roleArn`. An optional single execution
principal is paired explicitly to that enrolling role, issuer, Google client and
enrollment policy revision, with its own reviewed delegation revision. For example,
the synthetic fixture can add this property to its first product registration:

```json
{
  "executionDelegation": {
    "roleArn": "arn:aws:iam::111111111111:role/SyntheticWorker",
    "enrollmentRoleArn": "arn:aws:iam::111111111111:role/Synthetic0",
    "issuer": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic0",
    "clientId": "synthetic0",
    "enrollmentPolicyRevision": "synthetic-review-v1",
    "reviewedPolicyId": "synthetic-execution-review-v1"
  }
}
```

The parent product supplies the product name and permitted operations. All four
enrollment binding values must match the parent registration exactly. Configuration
rejects missing reviews, extra fields, directory delegations, duplicate products,
shared principal identities and role-name collisions hidden by IAM paths. One
role cannot enroll for one product and execute for another. Delegation cannot chain.

The enrolling principal alone obtains the challenge and resolves independently
verified ID/access evidence. The original canonical binding remains
`product + enrollment principal + issuer + client + enrollment policy revision`.
`sameBinding` remains exact. Execution continuation looks up that original binding
through the explicit current pair; it does not add the worker to alias provenance,
create a session, or copy membership authority. No canonical data migration is needed.

The caller's verified execution principal remains the worker in request context.
The pair revision belongs to the current trusted server registry, not a browser
claim or a token field. Replacing a worker or removing the pair denies subsequent
requests under the newly loaded configuration. Changing the enrollment revision
requires fresh BFF enrollment. Merely changing a delegation review label while
retaining the same approved relation does not expire that original enrollment.
Enabling a pair permits continuation of already enrolled sessions that match
that exact BFF binding; it does not require a new login solely to introduce the
worker. That effect must be included in the activation review. Requiring fresh
login instead needs a new enrollment policy revision and explicit BFF enrollment.
Runtime configuration changes require normal deployment; an in-flight invocation
or an older deployed version is not instantly revoked by editing source.

## Worker allowlist

| Method | Path | Meaning |
|---|---|---|
| GET | `/v1/identities/me` | Return the Person of an already enrolled access-token family |
| POST | `/v1/accounts/{UUID}/authorize` | Check current `console:read` or `console:write` permission |

Every other method/path is denied by central caller authentication before storage
side effects. Worker capabilities are intersected with the product's current
`console:read`/`console:write` capabilities. Membership operations, identity
enrollment/linking, account creation/list/detail and directory reads are forbidden.
Unknown/malformed methods, path suffixes and UUIDs do not widen the allowlist.

Both requests require the original human access JWT in the SigV4-signed
`X-Prospectus-Human-Token` header and temporary credentials of the paired worker.
The worker does not need an ID JWT. Request JSON accepts no authority fields.
Issuer, client, expiration, subject, `auth_time` and enrolled `origin_jti` lineage
remain checked. `/me` returns `{person:null}` for an unknown/unenrolled lookup or
rejects invalid evidence; neither permits execution. The authorization response
keeps its existing shape with Person/account/product/role/operation/revision.

The queue consumer must match the returned Person/account/product/operation to its
immutable original job provenance and check immediately before provider or state
effects. A successful response is a point-in-time decision, not an authorization
lease or transaction over a later provider action. Expired evidence, unknown
Person, missing membership, viewer write attempts, disabled entitlement and service
outages fail closed. No worker enrollment, replacement identity, cached positive
membership, or automatic refresh into an unenrolled session family is permitted.
Logout/session revocation is also enforced by the application's encrypted session
store; central local JWT verification alone does not query Cognito revocation.

## Verification and activation boundary

`accounts/execution-delegation.feature` precedes the implementation. Run:

```sh
npm run test:accounts:delegation
```

The suite uses synthetic RSA tokens and actual native Virtuus identity/account
files in disposable local namespaces. It covers original provenance, reconstructed
handlers, renewed JWTs in the enrolled family, exact route/operation denial,
unlisted/removed/disabled pairs, wrong product/issuer/client/policy/family,
expired/forged evidence, ambiguous/transitive configuration, current roles,
revocation, entitlements and storage outages. The JSON-lines synthetic harness
accepts the same property with only its existing `Synthetic*` fixture role names.
These fixtures do not establish deployed SigV4, real Google or S3 permissions.

Activation requires separate approval of the exact role pair and trust policies,
dedicated OAuth client and callback/logout/scopes, federation review ID, delegation
review ID, product capabilities, caller IAM route permissions and central API
resource policy. Preserve existing directory grants. Neither principal needs
direct central identity/account S3 access. No wildcard identity management or
cross-product entitlement grant follows from this contract.
