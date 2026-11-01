Feature: Billing profile per account
  An admin sets how a client account is billed, so that each account has exactly one billing mode, one
  billing contact and its payment terms. The profile is a billing file beside the account and never changes
  the account document. An account without a profile is not yet billable and works normally.

  Scenario: An admin sets a profile
    Given an account with no billing profile
    And an operator holding the accounts:admin:billing grant
    When the operator sets mode invoiced, currency usd and the billing contact "Example Ledger Co" at billing@example.invalid
    Then billing/profiles/<account>.json is created with revision 1, the creation operation id and an audit entry
    And the journal records the change once
    And the account document is unchanged

  Scenario: Net terms default to 30 days
    Given a new invoiced profile with no net terms override
    Then its net terms are 30 days
    When the admin sets a per-account override of 45 days
    Then the profile's net terms are 45 days

  Scenario: Only US dollars are accepted
    When an admin sets a profile with currency eur
    Then it is refused and nothing is written

  Scenario: A profile with no mode is not yet billable
    Given an account whose profile has no mode
    Then no billing line or invoice can be created for it
    And its memberships and entitlements work as before

  Scenario: Changing mode with open lines is refused
    Given a profile in invoiced mode with open billing lines for two products
    When the admin switches it to direct
    Then the switch is refused and the refusal names both lines
    When each line is re-homed by its own operation
    Then the switch succeeds

  Scenario: A line end whose release did not finish
    Given a line that ended but whose reservation was not yet removed from the profile
    When the admin switches the mode
    Then the switch succeeds and the stale reservation is dropped

  Scenario: An operator without the billing grant cannot set a profile
    Given an operator holding only accounts:admin:read
    When they try to set the profile
    Then the response is 403 forbidden and nothing is written

  Scenario: An account owner cannot set a profile
    Given a signed-in account owner
    When they try to set the profile
    Then the response is 403 forbidden and nothing is written

  Scenario: A replayed write returns the original result
    Given a profile write whose response was lost
    When the same operation id is sent again
    Then the same result returns and no second revision exists

  Scenario: Concurrent profile edits
    Given two admins edit the same profile from revision 3
    When both save
    Then one save succeeds as revision 4 and the other is refused as a revision conflict

  Scenario: The customer reads a masked profile
    Given an owner of an account with a billing profile
    When they read GET /accounts/<account>/billing in the portal
    Then they see the mode and a masked billing contact

  Scenario: Billing contact data is never identity and never logged
    Given a profile whose billing contact email is owner@example.invalid
    When a person signs in with that email
    Then the billing contact neither finds nor authorizes any Person
    And refused profile writes log a route, status and reason code with no name, email, address or tax id
