Feature: A real SaaS Accounts directory separate from CRM prospects
  Scenario: The Accounts backend is not configured
    Given a signed-in user opens Accounts without a configured directory service
    When the Accounts view loads or is refreshed
    Then it explicitly reports that the service is not configured
    And it shows no invented organizations or account-management actions

  Scenario: CRM membership is separate from SaaS account access
    Given a signed-in identity without Prospectus staff membership
    When the user opens the Accounts section
    Then no CRM issue listing or prospect controls are exposed
    And the directory requires its own authorized service response

  Scenario: Account detail responses cannot replace a newer refreshed list
    Given an account detail request is still pending
    When the user refreshes the Accounts list
    Then loading and detail state reset to the refreshed list
    And the stale detail response is ignored

  Scenario: Confirmation controls explain the current sign-in and remain usable
    Given I am signed in to Prospectus without confirmation for this Accounts session
    When I open Accounts
    Then I see that Google confirmation loads my existing memberships
    And the explanatory text can be selected
    And Refresh and Continue with Google have visible button styling
    When I start Google confirmation twice before it finishes
    Then only one confirmation attempt starts
    And I see progress with both controls disabled
    When confirmation fails
    Then I see an actionable error and can retry

  Scenario: Central operator administration is independent of personal membership
    Given a verified canonical person with current Google session proof
    And an explicitly approved accounts:admin:read grant for that exact product, issuer and subject
    When they open Account administration
    Then they can read all central organizations, entitlements and memberships
    And no organization membership or product entitlement is granted to them
    And their My memberships view remains restricted to their own active memberships

  Scenario: Operator access is inactive without an approved grant
    Given a CRM administrator or account owner without a central operator grant
    When they request the operator list or organization detail
    Then access is denied
    And no organizations or memberships are disclosed
    When an operator's grant is removed or their current identity proof is absent
    Then operator reads are denied

  Scenario: Repeated sign-ins do not serialize duplicate canonical identity reads
    Given one canonical Person has eight committed Google login receipts
    When the current identity is resolved
    Then every required canonical record is checked once within that lookup
    And at most four independent reads run concurrently
    And all committed session provenance remains available
    When a required canonical Person record is unavailable on the next lookup
    Then access is denied using fresh canonical reads

  Scenario: Account discovery overlaps reads without caching permissions
    Given several canonical accounts have current owner and viewer memberships
    When the account list is requested
    Then account reads run concurrently with a maximum of four
    And only currently authorized accounts are returned
    When a viewer membership is revoked
    Then the next list excludes that account
  Scenario: Reuse native storage transport within one request without caching authority
    Given one Accounts request reads several canonical records in the same namespace
    When the native Virtuus transport processes those reads and conditional writes
    Then it initializes its fixed storage client once for that request namespace
    And each read observes canonical changes made by another request
    And the transport closes when its request finishes
    And a later request performs fresh canonical authorization

  Scenario: One Google login serves the CRM and Accounts
    Given I am signed out and the Accounts service is configured
    When I choose Sign in
    Then the browser requests a challenge from the unauthenticated login-challenge route sending only a digest of its login state
    And the Google redirect carries the issued nonce and forces a fresh login
    And the login completion stores the session and then confirms Accounts with the original login state
    And no second Google login is needed to open Accounts

  Scenario: Sign-in still works when the login challenge cannot be issued
    Given the login-challenge route is throttled or unavailable
    When I choose Sign in
    Then the Google redirect carries no Accounts nonce and no forced re-login
    And Accounts confirmation can still be started from the Accounts tab

  Scenario: The unauthenticated login-challenge route is narrow and throttled
    Given the login-challenge route has no JWT authorizer
    Then it accepts only a same-origin POST containing a login state digest
    And it never reads or returns account data
    And the API stage throttles that single route while every CRM route keeps its JWT authorizer
