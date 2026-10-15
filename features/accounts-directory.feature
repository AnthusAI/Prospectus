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
