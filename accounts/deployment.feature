Feature: Activate the approved Accounts directory without changing CRM authority
  Scenario: Packaging is a deployment prerequisite
    Given the reviewed Linux x86_64 bridge and two Node24 handlers
    When the enabled deployment is built
    Then package persistence and denial checks must pass before Amplify deployment
    And the existing CRM resources and disabled intake remain unchanged

  Scenario: Directory authority stays scoped
    Given a caller without the registered directory runtime role or a valid human token
    When the caller requests an account directory operation
    Then the IAM or JWT boundary denies the request
    And account writes and other APIs remain outside the directory role permissions

  Scenario: Google identity alone grants no membership
    Given a fresh verified Google identity without an account membership
    When the person connects Accounts
    Then the directory returns no permitted accounts
    And no organization, membership or product privilege is created automatically
