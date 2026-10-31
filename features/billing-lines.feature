Feature: Plan catalog and billing lines
  A billing line is the billable unit, keyed by account and product, with a plan from the reviewed catalog.
  Each Papyrus site is its own product, so each site deployment is its own line, added, paused and ended on
  its own. The entitlement is access and the line is money; billing never grants or removes access.
  Prices in the catalog are test-mode placeholders until real pricing is decided.

  Scenario: The plan catalog is reviewed and validated
    Given accounts/billing-plans.json lists plan id, display name, product family, interval and a Stripe price id per Stripe mode
    When the service starts or the stack is synthesized
    Then an unknown field, a duplicate plan id or a price id shared by two plans stops it before serving

  Scenario: The catalog holds test-mode placeholders only
    Given the committed plan catalog
    Then every plan has a test-mode price id and no live-mode price id

  Scenario: Plans use the product family names
    Given site metadata naming the family papyrus
    Then Papyrus plans use the family papyrus
    And product display names come from the site metadata, not the catalog

  Scenario: An admin creates a line
    Given an account with an active entitlement for papyrus-example-invalid and a billing profile
    When an admin creates a line with a placeholder monthly Papyrus plan
    Then billing/lines/<account>/papyrus-example-invalid.json exists
    And its status is pending in direct mode until its subscription item is active, or active in invoiced mode
    And the journal records it once

  Scenario: Two sites, two lines
    Given one account entitled to two Papyrus site products
    When lines are created for both
    Then each line has its own status, plan and period
    And ending one does not touch the other

  Scenario: A line without an entitlement is refused
    Given a product the account is not entitled to
    When an admin creates a line for it
    Then it is refused with a message naming the missing entitlement
    And no entitlement is created

  Scenario: A line for a public-reader product is refused
    Given a public-reader Papyrus site product
    When an admin creates a line for it
    Then it is refused

  Scenario: A product may be granted with no line
    Given an account entitled to a product with no billing line
    Then the product works and nothing is billed for it

  Scenario: Pausing a line
    Given an active line in invoiced mode
    When the admin pauses it
    Then it produces no line item on later period invoices until it is resumed
    And the entitlement is unchanged

  Scenario: Ending a line
    Given an active line
    When the admin ends it with an end date
    Then the line is ended and the entitlement is unchanged
    And a follow-up asks whether to disable the product through the entitlement route

  Scenario: A line may outlive a disabled entitlement
    Given an active line whose product entitlement is disabled by an operator
    Then the line stays active until an admin ends it
    And a follow-up asks whether to end the line

  Scenario: An entitlement grant prompts but does not create a line
    Given an entitlement.changed event granting a product to an account with no line for it
    When billing receives the event
    Then an operator follow-up asks for a plan to be attached
    And no billing line is created

  Scenario: Direct-mode lines must share the subscription's interval
    Given a direct-mode account whose subscription is monthly
    When an admin creates a line with an annual plan
    Then it is refused with a message naming the interval

  Scenario: Only billing admins change lines
    Given an operator holding only accounts:admin:read, or a signed-in account owner
    When they create, pause or end a line
    Then the response is 403 forbidden and nothing is written
