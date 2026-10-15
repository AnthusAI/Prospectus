# Verified Google identity association — local implementation

Current integration story: kanbus-ee6aa6. Earlier proof-branch story IDs are not part of this main-based board.

This increment associates a canonical Person across registered Cognito pools using Google subject evidence. It grants no membership, account access, product entitlement or CRM staff access. Canonical key: (`https://accounts.google.com`, case-sensitive Google subject); Cognito (`issuer`, `sub`) aliases retain product, IAM principal, app client and reviewed-policy provenance. Email is ignored. Conflicting existing identity mappings return409; people are never silently merged.

## Exact BFF contract

All calls are backend-to-central requests signed with runtime temporary IAM credentials. Gateway-verified caller context selects the enabled product registration. Both token headers and request body must be signed. No browser token forwarding endpoint, raw Google ID or email input is accepted.

1. Before code+PKCE authorize redirect, POST `/v1/identities/google/challenge`, JSON `{}`. Return200 `{challengeId,nonce,expiresAt}`; expiry is Unix seconds, TTL300. Central binds role/product/pool/client/policy revision. BFF puts this nonce into Cognito authorize, retaining independent state, PKCE and challenge ID server-side bound to its browser login attempt.
2. On callback, independently verify the tokens locally, then POST `/v1/identities/google/resolve`, JSON `{challengeId}`, signed headers `X-Prospectus-Human-Token: <access JWT>` and `X-Prospectus-Identity-Token: <ID JWT>`. Return200 `{person:{id,createdAt}}`. The BFF can discard the ID JWT after success. Lost central responses can retry the identical evidence during the challenge lifetime; this does not authorize reuse of the browser OAuth state.
3. Continuation: GET `/v1/identities/me`, signed access header. Return200 `{person:{id,createdAt}}`, or `{person:null}` for a valid but unknown alias. It never enrolls. Current policy provenance and enrolled hash(origin_jti)+auth_time must match. Refresh within that family may continue without a new ID token; a new login family needs a new challenge.

Resolve independently verifies RS256 signatures and keys against the registered Cognito issuer for each token (different kids supported), exact `iss`, token purpose, expiry/issued-at/not-before. ID `aud` equals access `client_id` and the single registered federation client; pool `sub`, `auth_time` and nonempty `origin_jti` match. Authentication is at most300s old, future skew at most30s, and the ID nonce matches the unexpired challenge. Equality of `iat`/`jti`/signing key is not used to infer session identity. Access and ID evidence arrive via the BFF's nonce-bound code exchange, not an arbitrary browser-selected token pair.

ID `identities` must contain exactly one entry total with built-in `providerName=Google`, `providerType=Google`, and a nonempty bounded case-sensitive ASCII `userId`. Array order, `primary`, username and email never select a login identity. This only establishes Google identity under the reviewed Google-only, unlinked-profile policy below; signatures alone cannot establish that configuration.

Errors:400 malformed input/raw authority overrides/ambiguous headers;401 invalid JWT/session/nonce, expired challenge or new un-enrolled session family;403 wrong caller/challenge product/client/policy or changed alias policy;409 challenge consumed with changed proof or identity mapping conflict;429 local test capacity;503 unavailable repository. No raw JWTs or email persist centrally; challenge receipts retain only a token-pair digest and Person result.

## Registry and production assumptions

ProductRegistration keeps exact `product`, IAM `roleArn`, Cognito `issuer`, `clientIds`, capabilities and enabled flag, plus optional:

```json
{"googleFederation":{"policy":"google-only-unlinked-v1","reviewedPolicyId":"review-reference","clientId":"exact-client-id"}}
```

Missing federation policy denies these routes. The declaration is an operational approval input, not automatic inspection of AWS settings. Production must verify and control: built-in Google provider and intended Google project/client; Google-only client login; disabled alternative/native password/custom/client-credentials paths; absence of linked profiles; constrained administrator linking/password-setting and pre-token customization; token-revocation claims; callback/logout URLs; nonce/PKCE/state behavior and cookie/session security. Config drift must invalidate the review revision. Local JWT signature/expiry verification does not consult Cognito revocation state; immediate central token-family revocation is not implemented. BFF logout must invalidate its own server session, and production must explicitly choose revocation/maximum-session-age behavior. A compromised trusted pool administrator can undermine its assertions. No live settings or real tokens were inspected in this increment.

A profile with multiple/ambiguous identities must use an explicit fresh proof/linking flow; none is implemented here. Existing legacy Person/Cognito aliases must be checked by the eventual repository adapter, never overwritten during migration. Cross-domain account/CRM person continuity remains a separate integration requirement; a mismatch must fail closed before account side effects.

## Storage boundary and current scope

`googleIdentityHandler(repository, products, keys, nowSeconds?)` in `accounts/google-identity.ts` is an isolated transport factory. It is composed by `canonicalAccountsHandler`, with the explicitly enabled `canonical-lambda.ts` deployment entrypoint. Activation remains disabled; see ACCOUNTS_UI.md for the exact proposed registration and permission gate.

`GoogleIdentityRepository` now permits the recoverable pending/committed protocol Ryan approved. `accounts/durable-google-identities.ts` supplies a local filesystem-backed implementation through actual pinned Virtuus `FileStore`/`JournaledStore`; the memory adapter remains a synthetic alternative. See DURABLE_IDENTITY.md for phases, visibility, multi-process crash tests, shared account PersonDirectory and the explicit uncertain pre-publication operator case. This is not an atomic S3 transaction. An optional native S3 adapter and disabled additive deployment definition now exist. No cloud activation occurred, and no DynamoDB authority exception is implied.

## Verification and cross-language harness

`npm test` includes 27 real-RSA synthetic tests: cross-pool same/different Google identities, provenance, concurrent replay, alias conflict, forged/expired/stale/mismatched tokens, wrong caller/client/issuer/nonce/lineage, linked profiles, unknown continuation, changed policy/new family and separate-process harness.

JSON-lines test bridge: `node --import tsx accounts/testing/google-harness.ts`. Configure once with `{op:"configure",nowSeconds:<integer>,products:[...],keys:{"<issuer>":{"<kid>":<PUBLIC RSA JWK>}}}`. Harness requires synthetic pool names `us-east-1_Synthetic...` and role names `arn:aws:iam::111111111111:role/Synthetic...`. Then send `{op:"request",event:<RestEvent>}`; each output is a raw handler response `{statusCode,headers,body:<JSON string>}`. `{op:"advance",seconds:<nonnegative integer>}` advances its clock. No HTTP listener, AWS lookup or environment credentials. Fixture requestContext represents Gateway verified context; it does not prove SigV4 enforcement.

The console owner independently reports its real Python BFF/GoogleIdentityClient/SigV4Transport passing against this Node harness: same Google in two pools resolves one Person; synthetic account continuation/select/GraphQL proof; invalid ID issuer/client/family/nonce/linked identities denied; state replay stopped locally; exact central replay200 and changed proof409. This is synthetic integration, not deployed IAM, real Google login, or unification with the old account authority.
