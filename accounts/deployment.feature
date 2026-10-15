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

  Scenario: Approved console execution stays bound to its enrolling BFF
    Given the exact approved console roles have verified Lambda-only trust
    And the dedicated Google-only public client is provisioned in the central pool
    When the reviewed console pair is activated
    Then the worker can read its identity and authorize an account using the original BFF enrollment
    And the directory registration and storage grants are preserved
    And neither console principal can invoke directory or membership management routes
