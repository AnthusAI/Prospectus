Feature: Operators grant allowance and everyone sees real numbers
  Until billing can sell quota, an operator sets each account's allowance. The CRM and the Anthus One portal show
  the backend's numbers, a clear empty state for an account with no allowance, and an explicit unavailable state
  when the numbers cannot be read. See docs/QUOTA.md.

  Scenario: An operator grants an allowance
    Given an operator with the reviewed accounts:admin:quota permission
    When they set an account's allowance to 2500 cents with an operation ID
    Then the account's allowance is 2500 cents
    And the journal records the operator's reviewed grant ID as the actor
    And repeating the call with the same operation ID changes nothing
    And reusing the operation ID with another amount is refused

  Scenario: Only the reviewed quota permission may grant
    Given a person with operator read access only, with only the entitlements permission, or an account owner
    When they try to set an allowance
    Then the request is refused
    And unknown fields, a missing operation ID and negative or fractional amounts are refused

  Scenario: An allowance can be lowered
    Given an account with 800 cents held and an allowance of 1000 cents
    When an operator lowers the allowance to 500 cents
    Then the existing hold stays
    And remaining quota is negative and every new reservation is refused until the allowance is raised

  Scenario: The allowance of an unknown account cannot be set
    When an operator sets an allowance for an account that does not exist
    Then the request is refused as an unknown account

  Scenario: The CRM account page shows the real quota
    Given an account with an allowance, some use and a hold
    When staff open the account in the CRM
    Then the Quota used card shows what is used, the allowance and what is left
    And the Quota section shows the allowance, used, held and remaining amounts and the split by app

  Scenario: An account with no allowance shows an empty state
    Given an account no operator has granted quota to
    When staff or the account's members look at its quota
    Then they read that no quota has been granted and apps cannot start paid cloud work
    And no zero or invented figure is shown

  Scenario: Unreadable quota is shown as unavailable
    Given the quota store cannot be read
    When anyone looks at the account's quota
    Then the page says the quota could not be read and that apps cannot spend meanwhile

  Scenario: The portal shows the workspace's quota
    Given a signed-in member of an account with an allowance
    Then the header shows the quota left
    And Home shows a quota card and Usage shows the figures and the split by app

  Scenario: A product reads and writes quota through the server client
    Given a product's server role with temporary credentials
    When it uses the accounts client's server entry to reserve, settle and release
    Then each call is signed with SigV4 and carries no person or token
    And static or expired credentials are refused before anything is sent
    And a refusal, a store failure, a timeout or an unexpected response throws
