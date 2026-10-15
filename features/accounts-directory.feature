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
