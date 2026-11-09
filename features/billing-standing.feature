Feature: Billing standing limits access without writing it
  Ryan's rule (2026-11-08): a line long past due makes its product read-only, and a cancelled line has its
  deployment's data deleted after 30 days, with export available throughout. Billing never writes the account
  document; each line's standing is derived from the ledger, and authorization combines the entitlement with it.

  Background:
    Given an account "Example Press" entitled to the product "papyrus-example"
    And an active billing line for that product on Net 30 terms

  Scenario: A line with nothing past due is in good standing
    Given no invoice covering the line has a balance above zero past its due date
    Then the line's standing is good
    And authorize grants the member's read and write capabilities

  Scenario: Past due for 14 days makes the product read-only
    Given an invoice covering the line was issued on 2026-11-02 and is due on 2026-12-02
    And its balance is above zero
    When standing is read on 2026-12-16
    Then the line's standing is good
    When standing is read on 2026-12-17
    Then the line's standing is restricted with restrictedSince 2026-12-16
    And authorize withholds console:write and members:write and keeps console:read
    And the entitlement in the account document is unchanged

  Scenario: Partial payment does not restore standing
    Given the line is restricted
    When a payment is allocated that leaves a balance above zero
    Then the line's standing stays restricted

  Scenario: Paying restores editing automatically
    Given the line is restricted
    When payments bring every overdue invoice's balance to zero
    Then the line's standing is good
    And authorize grants write capabilities again
    And a billing.standing_changed event with standing good is published

  Scenario: Voiding, crediting or writing off also restores standing
    Given the line is restricted by one overdue invoice
    When an admin voids it, credits it to zero or marks it uncollectible
    Then the line's standing is good

  Scenario: Cancellation schedules deletion 30 days later
    When the line is ended by cancellation on 2026-12-01
    Then the line's standing is cancelled with deleteAfter 2026-12-31
    And authorize withholds write capabilities and keeps read capabilities, including export
    And a billing.standing_changed event with standing cancelled and deleteAfter is published

  Scenario: Deletion is the product's job, confirmed back
    Given the line is cancelled with deleteAfter 2026-12-31
    When the daily billing check runs on 2026-12-31
    Then exactly one deployment.deletion_due event is published for the account, product and deployment
    And Prospectus deletes no product data
    When the product confirms deletion
    Then the line's standing is deleted and the line stays on record

  Scenario: Standing takes effect without a scheduled job
    Given the daily billing check has not run
    When authorize is called after an invoice passes 14 days past due
    Then the line is treated as restricted

  Scenario: A product with no billing line is unaffected
    Given an entitlement to "papyrus-internal" with no billing line
    Then authorize grants the member's capabilities as before

  Scenario: Every standing change is journaled
    When a line's standing changes
    Then exactly one journal event records the account, product, old and new standing and the dates
    And a billing follow-up appears in the CRM Serve queue
