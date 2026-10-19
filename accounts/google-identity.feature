Feature: Verified Google identities across independently branded pools
  Identity association uses registered Cognito evidence and grants no account access.

  Scenario: One Google account in two registered pools resolves one person
    Given two reviewed Google-only unlinked product pools
    And each product obtains a login challenge before its code exchange
    When independently signed ID and access pairs have the expected nonce and the same Google subject
    Then both resolutions return one Person with distinct provenance-bearing Cognito aliases
    And no account memberships or entitlements are created

  Scenario: Email does not associate different Google accounts
    Given two valid token pairs have matching email but different Google subjects
    When their fresh challenges are resolved
    Then different People are returned

  Scenario: Lost responses and concurrent identical retries are idempotent
    Given a challenge has a committed identity resolution
    When independent workers retry the identical proof during the challenge lifetime
    Then the same Person is returned without a second association
    But different proof with the same challenge is rejected

  Scenario Outline: Invalid evidence never associates an identity
    Given <failure>
    When a Google identity resolution is attempted
    Then the request fails without consuming a successful association
    Examples:
      | failure |
      | wrong machine role or disabled product |
      | unreviewed federation policy |
      | wrong issuer or client audience |
      | forged, expired or stale ID or access token |
      | mismatched pool subject, authentication time or refresh lineage |
      | wrong, expired or replayed nonce with different proof |
      | multiple linked profiles or a non-Google identity |
      | a Cognito alias already bound to another Google identity or Person |

  Scenario: Continuation does not enroll new identities
    Given a valid enrolled Cognito alias
    When its registered product requests the current person using a valid access token
    Then the existing Person is returned without creating aliases
    And an unknown alias returns null
    And a changed federation policy requires fresh enrollment

  Scenario: Production composition returns whole Unix seconds for a challenge
    Given the production composition uses a wall clock with fractional seconds
    When the enrolled product requests a login challenge
    Then issuedAt and expiresAt are whole Unix seconds
    And expiry is in the future and no more than 300 seconds from the current time
    And matching fresh signed login evidence still resolves that challenge

  Scenario: Recoverable canonical files never authorize a partial enrollment
    Given enrollment writes ordinary canonical files through Virtuus conditional journals
    When a worker crashes before or after any publication phase
    Then a fresh worker can resume the recorded decision without changing the Person
    And pending or partially linked records never authorize identity or account access
    And a lost response is recovered using the existing operation receipt

  Scenario: Independent processes reserve one Google identity and reject conflicting aliases
    Given multiple processes share a Virtuus filesystem namespace
    When the same Google account signs in concurrently through different pools
    Then one canonical Google file determines the Person for all committed aliases
    And a conflicting alias cannot be overwritten

  Scenario: Account operations consume the same canonical Person directory
    Given a committed Google enrollment and an account service using that directory
    When accounts are created listed and authorized
    Then every result uses the enrolled Person ID
    And membership role entitlement and last-owner checks still apply
    And a conflicting prior Person mapping fails before any account side effect

  Scenario: A challenge requested before sign-in is bound to the browser login state
    Given a browser has generated its login state and sent only a digest of it
    When the product requests a login challenge carrying that digest before the browser signs in
    Then the challenge is issued with the same 300-second lifetime and a single-use nonce
    And resolving it requires fresh login evidence and the original login state
    And a missing, different or unexpected login state is rejected without consuming the challenge
    And the matching login state still resolves the challenge afterwards
    And a challenge issued without a digest rejects any supplied login state

  Scenario Outline: Malformed login state fields are rejected
    Given a product requests or resolves a challenge with <field>
    Then the request fails with a 400 status before any challenge is stored or consumed
    Examples:
      | field |
      | a login state digest that is not 64 lowercase hexadecimal characters |
      | a login state outside the base64url alphabet |
      | an unknown extra field |

  Scenario: Login evidence older than 300 seconds never resolves a bound challenge
    Given a bound challenge and matching login state
    When the login evidence authentication time is older than 300 seconds
    Then resolution fails with a session binding error
