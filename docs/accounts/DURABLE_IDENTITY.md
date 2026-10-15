# Recoverable canonical identity files — local proof

Ryan approved recoverable enrollment: internal pending records may survive, but no Person/session access is exposed until its login receipt commits. This is a recoverable multi-file protocol, **not an atomic S3 transaction**. Current main-based integration story: kanbus-ee6aa6; historical proof-branch checks below remain local evidence.

## Authority and implementation

`accounts/durable-google-identities.ts` orchestrates identity-domain phases using `IdentityFiles`. `accounts/identity-files.ts` invokes the private Rust executable built by `npm run build:identity-files`. The executable in `local-dependencies/intake-control/src/bin/identity-files.rs` uses the existing pinned Virtuus639f873 `FileStore`, `JournaledStore`, opaque absent/revision conditions, intent replay and execution claims. The default build/backend remains filesystem only. The optional AWS feature enables an explicitly configured S3 backend; it has no HTTP listener or deployed route. Both backends restrict writes to the identity namespace, separate from the CRM project. See [Accounts activation review](ACCOUNTS_UI.md) for the exact proposed S3 scopes and unexecuted cloud verification gate.

Canonical root is `<configured-root>/local/identities/`:

- `google/<versioned-tuple-sha256>.json`: canonical Google issuer/subject and winning UUID Person. The path is deterministic; the winning create-only file fixes the Person ID.
- `aliases/<versioned-tuple-sha256>.json`: immutable Cognito issuer/subject -> Google key and Person. Different mapping fails explicitly, never overwrites.
- `people/<UUID>.json`: canonical Person lookup pointer, always verified against the Google file and a completed enrollment before returning a known Person.
- `logins/<challengeUUID>.json`: pending/prepared/committed/conflicted challenge, frozen verified evidence summary, candidate and winning Person receipt. Contains no raw JWT/email. Nonce, subject identifiers and lineage/proof digests are private identity data.
- `sessions/<GoogleKey>/<AliasKey>/<challengeUUID>.json`: lookup pointer to a canonical committed login receipt. Pointer presence alone never authorizes.

All are ordinary JSON files. Virtuus `_virtuus/local/identities/` holds supplemental journal/control metadata outside canonical export. The local process catalog is disposable and never permission authority. The quiescent completed-file copy test reconstructs access from ordinary canonical files without source journal/catalog state.

## Phases and concurrency

1. Issue challenge with create-only journal operation.
2. CAS pending -> prepared, freezing proof fingerprint/binding and candidate Person. Replay looks up the recorded Virtuus intent before accepting regenerated candidates.
3. Create deterministic Google identity file; a conditional loser adopts the authoritative winning Person.
4. Create immutable Cognito alias, or reject a conflicting existing mapping.
5. Ensure Person lookup pointer.
6. Publish session pointer, still unusable while the login remains prepared.
7. CAS login -> committed, recording the winning Person. Only then return success.

Each phase has a stable operation ID and logical request digest. Every write uses Virtuus journal replay and actual conditional publication. No Node filesystem writes implement a substitute storage authority. Multiple processes coordinate through Virtuus, not an application-memory mutex.

`find()` reads canonical alias/Google files and verifies session pointers against committed login receipts. `getPerson()` likewise requires a committed enrollment. A Person committed through another pool does not make this pool's pending alias usable. Readers accept at most256 session pointers and bound each canonical read to64KiB; exceeding the limit fails closed. A final100-item backend page can overshoot the accepted pointer count before rejection, and local filesystem enumeration work depends on subtree size. Retention/index compaction and production sizing are not yet implemented.

Identical proof retry within challenge lifetime returns the original Person; changed proof409. A conflicting alias marks that enrollment conflicted. A verified Google reservation can remain after a failed alias attempt, but creates no usable session or membership. Internal `recover(challengeId)` resumes a frozen prepared decision after expiry; it is not an authenticated public API. Public resolve/me still validate current JWT signatures, expiry and enrolled session family, so repair cannot turn expired evidence into authorization.

## Failure behavior

The suite kills real Node workers before/after all seven phases and restarts with the same files. Lost bridge responses and termination after native canonical publication/before journal receipt recover via surviving Virtuus operation metadata. No Person is regenerated, and no pending record authorizes access.

An execution claim interrupted **before canonical publication** can remain uncertain. The exact pinned Virtuus contract forbids automatic claim stealing or timeout reset because a native S3 request could arrive late. The test proves repeated repair stays denied. Operator recovery must establish the owner/request has stopped and reconcile the intent/canonical metadata using a separately reviewed procedure; no automatic or public reset is implemented. This is an explicit availability limitation, not successful automatic recovery for that case.

Direct imports/edits must be quiescent; do not overwrite/delete immutable identity files or copy unresolved in-flight state and claim a complete export. Filesystem roots must be trusted and restricted to cooperating writers. The tests cover process crash/restart, not disk/power-loss durability or actual S3 failure modes.

## Shared Person directory and accounts

`accounts/person-directory.ts` supplies canonical Person lookup using registered product, exact pool/client/policy and the enrolled access-token session family. `AccountsService` accepts this directory. With it injected, account resolve/create/list/authorize consume the same committed Person; they cannot independently generate another Person. Legacy identity mismatch409 happens before account writes. Pending enrollment403 occurs before account coordination writes. Directory-backed explicit legacy linking is denied pending a separate reconciliation flow.

The account prototype may retain an id/createdAt coordination copy under `PERSON#id` for its existing membership transaction/version checks. That copy cannot authorize or redefine identity: it must equal canonical data and all identity resolution uses the directory. This does not approve its DynamoDB membership schema as production storage. Viewer restrictions, caller-product entitlements, revocation and last-owner rules remain intact.

The JSON-lines harness accepts optional `filesystemRoot` to persist identities, and optional `accountsFixture:true` to route actual `/v1/accounts*` handlers through that shared directory. Accounts/memberships remain `MemoryAccountStore`, disappear on central harness restart, and cannot be described as durable. Product0 accounts do not automatically grant product1 entitlement even when both resolve the same Person.

## Verification

- `node --import tsx --test accounts/durable-google-identities.test.ts`: 29/29 passed on this branch; builds pinned native bridge, then phase crashes/restart, lost/native uncertain responses, eight-process convergence, conflicting aliases, expired-proof denial, shared-Person account authorization, pending/conflicting no-side-effect gates and canonical-copy tests.
- `npm test`: 46 passed, two optional browser tests skipped on this branch; existing CRM/auth/client and 27 real-RSA Google evidence cases.
- The old transactional DynamoDB account deployment prototype is excluded from this branch. Current durable account/directory/BFF tests use actual Virtuus files; DynamoDB is not authority.
- `npm run typecheck`, `npm run build:accounts`; Rust1.98.1 rustfmt and clippy with warnings denied for the new bridge.

The console owner separately verified actual Python BFF/SigV4 client -> durable central harness AND actual accountHandler/AccountsService/PersonDirectory. Account create/list/select/authorize and GraphQL use the enrolled Person; exact account-create retry returns the same ID, changed input is rejected, and another product lacks entitlement. Restart preserves identity receipts but clears memory accounts/selections and denies old account IDs. `requestContext` is a synthetic Gateway fixture; this does not verify deployed SigV4 enforcement or real Google login.

## Smallest actual-cloud test plan — not executed

After review of exact resource/access scope, run the same Virtuus repository contract against a uniquely scoped disposable S3 identity fixture, separate from CRM/customer records. Prefer an approved existing test bucket/prefix and temporary runtime credentials; no new user keys or new canonical DynamoDB table. The native S3 adapter and explicit trusted namespace are now implemented and locally tested; the corrected Papyrus account712236451410 is verified read-only, but a private synthetic test bucket and exact access review are still pending. No cloud writes are allowed to the old Cyclotron target.

First test conditional Google/alias reservations from two workers, full enrollment/restart/replay, pending denial, injected lost responses and metadata-based recovery; compare exported ordinary canonical paths/bytes. Verify prefix isolation, denied unrelated paths and absence of sensitive token logging. Test any uncertain pre-publication case as fail-closed, without reset. Define retention/cleanup and verify fixtures are quiescent before approved cleanup. Then, separately review exact product-role/API invocation policies and Google-only Cognito client settings before an end-to-end synthetic hosted login. No IAM/OAuth/live-auth/publication change is authorized by this local proof.


### Durable accounts follow-up

`accounts/canonical-handler.ts` now composes the same canonical PersonDirectory with `DurableAccountsService`, using a separate per-account canonical JSON aggregate and native revision CAS. See [durable accounts](DURABLE_ACCOUNTS.md) for the new45-test local persistence proof, many-to-many authorization, capacities and exact harness flag. Existing `accountsFixture:true` intentionally remains memory-only; new `durableAccounts:true` with filesystemRoot persists both identity and accounts. The console owner has now independently reported a passing actual Python BFF durable mode against central bf655d5: accounts/selections/GraphQL authorization persist across restart, many-to-many roles and revocation remain enforced, and same-email different-Google Persons stay separate. Its final console checkpoint is785ebf8, with all three older control modes passing; see the linked account handoff for exact evidence and limitations.
