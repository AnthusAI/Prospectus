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
    And no account, membership or product privilege is created automatically

  Scenario: Approved console execution stays bound to its enrolling BFF
    Given the exact approved console roles have verified Lambda-only trust
    And the dedicated Google-only public client is provisioned in the central pool
    When the reviewed console pair is activated
    Then the worker can read its identity and authorize an account using the original BFF enrollment
    And the directory registration and storage grants are preserved
    And neither console principal can invoke directory or membership management routes

  Scenario: The login challenge signer is part of the reviewed deployment configuration
    Given the deployment configuration names a parameter-store or kms login challenge signer
    Then CDK grants only ssm:GetParameter on the named parameters, or creates the kms key and its two permissions, and never both
    And a missing or malformed signer configuration stops the build
    And no secret value is stored in the repository, the template or the Lambda environment

  Scenario: Production configures the quota rate table parameter
    Given the production deployment configuration names the reviewed v1 quota rate table parameter
    When the deployment options are read
    Then they carry the quota rate table, so a deploy creates the SecureString once with a refusing placeholder
    And the central runtime role may read only that parameter and the initializer may only create it
    And a malformed parameter name stops the build
    And the configuration holds no rates, allowances or amounts

  Scenario: Quota refuses until a real rate table is written
    Given the quota rate table parameter still holds its placeholder
    When a product checks, records or reserves quota for an Account
    Then the answer is 503 quota_unavailable and nothing is charged
    And once a valid table with a default plan is written, an Account with no operator-chosen plan gets that plan's allowance
    And an Account gets no_allowance only when the table has no default plan and the Account has no plan or override
