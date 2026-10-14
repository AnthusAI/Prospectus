Feature: A private sales workspace built from Kanbus
  Scenario: Members sign in through Google with a verified OAuth callback
    When a visitor selects Sign in with Google
    Then Cognito authorization requests Google with an authorization code and S256 PKCE
    And the callback requires the matching state and saved verifier before exchanging the code
    And the API session stores the returned access token

  Scenario: An authorized salesperson follows a prospect into customer success
    Given an authenticated member and an empty Kanbus project configured for prospects
    When the member creates a prospect with contact details and a follow-up date
    Then the prospect appears in the configured sales board
    When the member follows the configured transitions into the customer stage
    And assigns the next follow-up and records a note
    Then the same issue ID, contact details and history remain available after reload

  Scenario: A competing edit does not overwrite another salesperson
    Given two members have read the same prospect revision
    When the first member updates it and the second saves their stale revision
    Then the second member sees a conflict and can reload the current record
    And the first member's changes remain intact

  Scenario: Public visitors cannot read CRM records
    Given a visitor without a member token
    When the visitor opens the application or requests issue data directly
    Then the application offers sign-in and the API denies issue access
    And the static application contains no prospect records or credentials

  Scenario: Follow-up views use general Kanbus queries
    Given prospects and other issue types with different assignees and follow-up dates
    When a member selects their due follow-ups
    Then the application requests type, assignee and a generic custom-field range
    And only matching prospects appear in the shared Kanbus list
