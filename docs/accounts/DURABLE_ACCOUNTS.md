# Durable account and membership slice — local contract

Central identity already has recoverable canonical files. The earlier memory-backed account proof and an older disabled transactional DynamoDB prototype were not production membership authority; the memory service has been removed. This slice persists account authorization locally through pinned Virtuus without simulating an atomic multi-file transaction.

## Behavior specifications written before implementation

- Given an enrolled canonical Person, account creation publishes one ordinary JSON account document with its initial owner, caller-product entitlement and creation receipt. Restart preserves its account ID, name, membership and permissions.
- Given the same Person/product/creation request UUID, a deterministic versioned account path and frozen input fingerprint return the same account after a lost response. Changed input is409; no second account is created.
- Given multiple accounts and people, membership is many-to-many. Every read/write checks the selected account's active membership, role, current registered product capability and that account's product entitlement. Knowing a Person or account ID grants nothing.
- Given a viewer, revoked member, unsupported product or unknown/pending Person, writes are denied before canonical account mutation.
- Given concurrent membership changes, revision CAS on the complete account document rechecks actor permission on conflict. Concurrent owner demotions cannot remove the last owner; a revoked actor cannot publish a stale authorized mutation.
- Given canonical files copied quiescently without supplemental journals/indexes, account lists and permissions reconstruct from those files. DynamoDB is never authority and is not needed for local verification.
- Given malformed/oversized canonical data, too many scanned accounts or a capacity limit, fail closed without dropping audit or granting partial access. An uncertain native operation retains its intent; no lock timeout reset is added.

## Canonical representation and deliberate limits

One `<scope>/accounts/<UUID>.json` document owns account metadata, memberships keyed by Person UUID, entitlements keyed by registered product, immutable creation fingerprint and append-only bounded audit. One conditional document write therefore commits all authorization changes for that account. Person identity remains in the existing canonical identity directory; no reciprocal membership copy can grant access.

Account creation IDs derive deterministically from a versioned tuple of canonical Person, product and request UUID; the original random request UUID is not stored. IDs remain UUID-shaped opaque identifiers, not authorization secrets. Account lists scan a bounded canonical account prefix, then validate/filter each document. A future DynamoDB index can find candidates but every result must be rechecked against canonical documents.

Initial local MVP limits: at most256 account documents in a list scan; at most100 total membership entries per account (including revoked entries), at most128 retained audit entries and64KiB per account document. Full capacity fails explicitly; no silent audit truncation. The old transactional prototype's person-wide100-account counter is not carried forward: a strict cross-account quota would require a separate recoverable coordination protocol. This is a capacity policy gap, not an account authorization gap. Production scan/index sizing and audit rollover remain later work.

No live CRM files or runtime deployment are changed. Shared destination remains prospectus.anth.us in papyrus-production712236451410. Lab console hosting/OAuth/registered invocation trust is not enabled by this local slice.


## Implementation and exact local verification

`accounts/durable-accounts.ts` implements the same public methods used by `accountHandler`. `accounts/canonical-handler.ts` composes the actual Google identity and account REST handlers over one canonical PersonDirectory and separate trusted file scopes. It is dependency-injected local runtime code; the old disabled deployment entrypoint is not silently enabled or replaced.

`VirtuusAccountFiles` uses the same pinned Rust bridge, FileStore and JournaledStore as identities, in a distinct fixed `local/accounts` scope. Canonical files are `<root>/local/accounts/accounts/<UUID>.json`; controls are `<root>/_virtuus/local/accounts/…`. `VirtuusS3AccountFiles` selects equivalent server-owned `<tenant>/accounts` scope through pinned S3Store; no actual cloud account writes have been tested. The bridge refuses identity-domain paths in the accounts scope and account-domain paths in the identity scope.

Native absent/revision conditions enforce account creation and changes. A membership change whose CAS conflicts reloads actor membership and entitlement before retrying. Brief contention/uncertainty reconciles the **same frozen** journal operation up to four attempts; it never resets an execution claim or generates a replacement operation while the outcome is uncertain. A surviving pre-publication claim stays denied. A lost post-publication acknowledgment can reconstruct its receipt from native operation metadata. An identical already-applied membership setting is a no-op after current authorization, so a lost caller response does not duplicate audit.

```bash
npm run test:accounts:durable
npm run test:canonical:durable
npm test
npm run typecheck
```

Verified:16 durable account tests and29 durable identity tests passed together (45 total);69 default regressions passed with1 opt-in UI skipped. The account suite includes independent workers, concurrent identical creates and conflicting owner demotions, stale actor revocation before CAS, product entitlement disablement, many-to-many account selection, canonical copy without journals, native publication interruptions, bounded audit/malformed-data denial and actual RSA/REST handlers. The actual JSON-lines central process was stopped/restarted with the same root: both product accounts, Person, creation replay and product isolation persisted. Native S3 loopback/configuration3 tests passed; no actual S3 account durability claim.

## Console integration handoff through parent

The synthetic JSON-lines harness serves identity only unless durable accounts are enabled. To opt into durable identity **and accounts**, configure:

```json
{
  "op": "configure",
  "filesystemRoot": "/absolute/disposable/synthetic-root",
  "durableAccounts": true,
  "nowSeconds": 1900000000,
  "products": "existing synthetic registrations array",
  "keys": "existing public RSA JWKS mapping"
}
```

The strings for products/keys above are explanatory placeholders, not executable fixture values; supply the same actual arrays/mappings used by the existing console proof. Tokens remain synthetic, only public RSA keys enter configuration, and the harness opens no HTTP listener or AWS credential chain.

The earlier console proof at7a8abe2 used a memory account store, since removed. On 2026-10-15 the console owner independently reported PASS for `--filesystem --durable-accounts` against central commit `bf655d5e4ac6c3775fdecbc9aa07bb79af9072f5`. Its configuration sends `durableAccounts:true`.

The actual Python BFF -> canonicalAccountsHandler -> Virtuus identity/accounts chain retains account lists, names, roles, entitlements, selected account and GraphQL authorization across central restart. Two Persons with the same email but different Google subjects remain separate. Two Cyclotron accounts prove many-to-many owner/viewer/member behavior: viewer writes denied; member writes reach only the selected store; nonmembers and random accounts denied. Revocation removes selected access and remains effective after a second central restart. Product1 still cannot access product0 accounts. Exact account-create retry across restart keeps the ID; changed input is refused; identical membership update leaves the revision unchanged. Existing JWT/proof/session-family checks remain.

This is console-owner-reported synthetic local evidence, not a rerun by this central worker or a real Google/Gateway/cloud deployment claim. The console owner finalized this proof at `785ebf8` on `codex/prospectus-console` and reports all three older control modes PASS. Active viewers remain read-only after restart; revoking one membership preserves the other account, while revoking both clears selection and denies direct writes after a second restart. Changed create input is denied before and after restart. No console files were edited by the central worker.

## Shortest remaining hosted path and approval boundary

1. Console durable local proof is finalized at785ebf8, with all three older control modes passing as reported above. This local integration step is complete; no cloud bucket or new permissions were needed.
2. Choose/review an existing private Papyrus canonical/proof bucket and exact namespaces, or review creation of a dedicated bucket if none is suitable. Run the already opt-in S3 contract and extend it to account aggregates. Papyrus account712236451410 was verified read-only; no cloud write target is selected.
3. Review the central runtime/package (including a Linux native Virtuus bridge), real registered product identity evidence, dedicated console OAuth client/exact lab callback, and scoped invocation policy. The current deployed entrypoint is still the old disabled prototype; no central hosted activation is claimed.
4. Only after those concrete cloud changes are approved, deploy the central endpoint and the console's real Python BFF/runtime wiring. Many-to-many authorization is server-side; the account selector alone does not enable central accounts.

Read-only inventory and the local steps above require no new cloud permission. Creating resources, granting/expanding IAM invocation or cross-account trust, modifying OAuth clients/callbacks, and deploying are the concrete held actions. No secret transmission or new credentials are necessary for this local increment. `lab.cyclotron.anth.us` could not be resolved by the current environment's unauthenticated header probe; that is not proof of a global outage or a live integration test.

Before production, review the explicit scan/audit capacity and absence of strict cross-account quota enforcement. No audit rollover, invitation/email workflow, billing, automatic entitlement grant across products or customer-data migration is included.


For the current main-based UI/BFF integration, activation gate and exact API/export handoff, see [Accounts UI](ACCOUNTS_UI.md). Historical proof results above remain local evidence; no cloud activation is implied.

## Membership index

Listing a person's accounts used to read every canonical account document, with a hard limit of 256 accounts. Each active membership now also has a create-only marker at `members/<personId>/<accountId>.json`, written before the account document publishes. With `membershipLookup: "indexed"` in `accounts/deployment.json`, `GET /v1/accounts` and `GET /v1/account-directory` list only the person's markers and read only those accounts. Markers never grant anything: every candidate is checked against its account document, so a revoked membership or an account that never published is not listed. Revocation leaves the marker in place. The operator listing still reads every account.

Rollout, with each AWS step run from Ryan's Mac:

1. Deploy with `membershipLookup: "scan"` (the current setting). New accounts and memberships start writing markers; listings still use the full scan.
2. Build the bridge with S3 support (`PROSPECTUS_BUILD_IDENTITY_S3=true npm run build:identity-files`) and backfill markers for older accounts. Without `--write` the script only counts accounts and active memberships:
   `PROSPECTUS_ACCOUNTS_BUCKET=<bucket> PROSPECTUS_ACCOUNTS_OWNER=<account> node --import tsx scripts/rebuild-membership-index.ts`
   then with `PROSPECTUS_MEMBERSHIP_INDEX_APPROVAL=<account>/<bucket>` and `--write`. Rerunning it is harmless.
3. Change `membershipLookup` to `"indexed"` and deploy.

The runtime role already covers `prospectus-central/accounts/*`, which includes the markers, so no IAM change is needed.

## Product access

An account starts with only the product it was created from. An operator can grant or disable another registered product with `POST /v1/account-directory/operator/accounts/<accountId>/entitlements/<product>` and the body `{"status":"active"}` or `{"status":"disabled"}`. A grant gives the product its registered capabilities, which members still use only within their role. Disabling denies that product's authorize calls and keeps memberships and all account data. Each change is an `entitlement.changed` audit event under the same revision check as membership changes.

Only a person holding a reviewed `accounts:admin:entitlements` grant in `accounts/operator-grants.json` can call the route. Operator read access is not enough, and account owners cannot grant products to themselves. No such grant exists yet. The directory BFF's API Gateway policy still allows only `GET` on the account directory, so making the route reachable also needs that policy change, which is held for approval.
