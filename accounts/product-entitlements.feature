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

  Scenario: An operator turns a product on from the staff admin site
    Given an operator whose reviewed grant in accounts/operator-grants.json includes the entitlements permission
    And the operator is signed in to the staff admin site
    When the operator turns a registered product on for an Account
    Then the staff service forwards exactly the status "active" for that Account and product to the central service
    And the Account's members can use that product within their roles
    And turning it off again denies that product's authorize calls and keeps memberships and Account data

  Scenario: The staff service forwards nothing but a valid status for a valid Account and product
    Given an operator signed in to the staff admin site
    When the request has an extra field, an unknown status, a malformed Account ID or product name, or another origin
    Then it is refused before the central service is called

  Scenario: An operator without the entitlements permission is refused
    Given an operator whose reviewed grant allows only reading Accounts
    When the operator turns a product on for an Account
    Then the central service refuses the request and nothing changes
    And the staff admin site shows that the entitlements permission is missing

  Scenario: The customer portal cannot change products
    Given a person signed in to the Anthus One customer portal
    When they send the product change request to the customer service
    Then the request is refused before the central service is called
    And the customer portal's central role is not allowed to invoke the operator entitlement route
    And neither is any product role: only the staff service role is
