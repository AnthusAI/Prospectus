Feature: Pairwise site subjects for public-reader Papyrus sites
  A public-reader site (audience "public-reader", today papyrus-shipped) identifies a person by a stable subject
  that is unique to that site, in the style of an OpenID Connect pairwise subject. The global Person ID never
  leaves Prospectus for such a site. Editor and member sites keep receiving the Person ID as before.

  Background:
    Given the site subject secret v1 is an SSM SecureString read by the central runtime
    And siteSubject = "ss1_" + base64url(HMAC-SHA-256(secret_v1, "prospectus-site-subject:v1\n" + product + "\n" + personId)) without padding

  Scenario: A reader site receives only its own subject for the person
    Given a person enrolled through a public-reader site
    When the site calls identity resolve, /v1/identities/me or the account list
    Then the person is exactly {"siteSubject": "ss1_<43 base64url characters>"}
    And no response body, error or log line contains the Person ID, the person's creation time or the Google subject

  Scenario: The subject is stable for the site
    Given a person enrolled through a public-reader site
    When the site resolves the same person again or asks /v1/identities/me later
    Then it receives the same siteSubject every time

  Scenario: Different reader sites receive unrelated subjects
    Given one Google account enrolled through two public-reader sites
    When each site resolves the person
    Then the two siteSubjects differ and neither can be computed from the other without the secret

  Scenario: Editor and member sites are unchanged
    Given a person enrolled through an editor site or any other registered product
    When the product resolves the person
    Then it receives {"person": {"id": <Person ID>, "createdAt": <time>}} exactly as before

  Scenario: A missing secret fails closed
    Given the site subject secret is not configured, missing, unreadable or shorter than 32 bytes
    When a public-reader site calls any identity route
    Then it receives 503 identity_unavailable before any enrollment work is done
    And it never receives a Person ID in its place
    And editor sites are unaffected

  Scenario: The secret never rotates silently
    Given the v1 secret is created once and retained
    Then a changed or deleted v1 value would change every subject, so rotation is a versioned migration to ss2_
    And the secret is created by a create-only deployment step that never overwrites, logs or returns the value

  Scenario: Retired subjects after a Person is deleted
    Given a Person enrolled on a reader site is deleted
    When the deletion retires the Person's site subjects
    Then that site's GET /v1/accounts/site-subjects/retired lists {"siteSubject", "reason": "deleted", "retiredAt"}
    And the site drops the data it holds for that subject

  Scenario: Retired subjects after a Person is merged
    Given a Person enrolled on a reader site is merged into a surviving Person
    When the merge retires the merged Person's site subjects
    Then the site's retired list carries reason "merged" and the surviving Person's siteSubject for that site
    And the site remaps its data from the retired subject to the surviving subject

  Scenario: The retired list is scoped to the caller's own site
    Given retirements recorded for two reader sites
    When one site calls GET /v1/accounts/site-subjects/retired
    Then it sees only its own retired subjects and nothing about the other site
    And editor sites and every other product are refused
    And the list is paged with an opaque cursor in "since", ordered so that no record is skipped
    And the route lies under the existing GET/v1/accounts/* access-policy entry, so the API access policy does not grow

  Scenario: Retirement times do not link sites
    Given a retirement recorded for a person on two reader sites
    Then each record's time is the hour the retirement was recorded, not the exact time
    And records within one hour are ordered by the site's own subject, so two sites cannot align them by order
    And a record is listed only after its hour has ended
