Feature: Grant and disable product access on an account
  Scenario: Grant a product
    Given an account and an operator with the reviewed entitlements permission
    When the operator grants a registered product such as Cyclotron Lab
    Then the account's members can use that product within their roles
    And the change is recorded in the account's audit history under a revision check

  Scenario: Disable a product
    Given an account with an active product entitlement
    When the operator disables it
    Then that product's authorize calls are denied
    And other products, memberships and account data are unchanged

  Scenario: Only reviewed operators may change products
    Given a person with operator read access only, or an account owner
    When they try to grant a product
    Then the request is refused
    And unregistered products and unknown fields are refused
