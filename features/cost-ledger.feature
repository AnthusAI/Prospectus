Feature: Private cost ledger in real dollars
  Prospectus records what each Account actually costs Anthus, in integer microdollars, by app, deployment,
  category and UTC day. Live reports are estimates; the day's imported actual replaces the estimate for the same
  Account, app, deployment, category and day and is never added to it. The ledger is never shown to a customer or
  returned to a product.

  Background:
    Given an Account "Example Press"
    And a private price list pricing "openai.tokens.input" at a made-up 2 microdollars per token

  Scenario: A live report is priced and recorded as an estimate
    When a usage message reports 1000 "openai.tokens.input" for app "papyrus", deployment "example", on 2026-11-09
    Then costs/<account>/20261109.json holds an estimate of 2000 microdollars for that app, deployment and category
    And exactly one journal event records the message, its items, the price list version and the amount

  Scenario: A repeated message is counted once
    Given a usage message with operation ID X was recorded
    When the same message is delivered again
    Then the day's totals are unchanged and no new journal event is written

  Scenario: The same operation ID with different content is refused
    Given a usage message with operation ID X was recorded
    When a different message arrives with operation ID X
    Then it is refused as an idempotency conflict and nothing is charged

  Scenario: An imported actual replaces the estimate
    Given an estimate of 2000 microdollars for "papyrus"/"example"/"openai.tokens.input" on 2026-11-09
    When the daily import records an actual of 1800 microdollars for the same key and day
    Then the day's amount for that key is 1800, not 3800
    And the correction of -200 microdollars is charged to the current quota week

  Scenario: A cost that only comes from the import
    When the daily import records 350 microdollars of "aws.appsync" for "papyrus"/"example" on 2026-11-09
    Then the day's amount for that key is 350 and it is an actual

  Scenario: Re-running an import for the same day changes nothing
    Given the import for 2026-11-09 was recorded
    When the same import runs again with the same figures
    Then the totals and the quota are unchanged

  Scenario: A later import for the same day corrects it
    Given the import for 2026-11-09 recorded 350 microdollars of "aws.appsync"
    When a later import reports 360 for the same key and day
    Then the day's amount is 360 and the correction of 10 is charged to the current quota week

  Scenario: Monthly charges are spread over the month
    When the import records a 500000-microdollar monthly charge for a key in November 2026
    Then each of the 30 days of November carries 16666 or 16667 microdollars of it, summing to 500000 exactly

  Scenario: The day document stays bounded
    Given thousands of usage messages for one Account on one day
    Then the day document holds only per-key aggregates and its size does not grow with the number of messages
    And every message is its own journal file

  Scenario: Integers only
    Then every amount is an integer number of microdollars and no floating point is used

  Scenario: Unknown item kinds are refused, not free
    When a usage message reports an item kind the price list does not know
    Then that message is refused with unknown_item_kind, nothing is charged, and the refusal is journaled

  Scenario: Never shown to customers or products
    Then no customer view and no product response contains a dollar amount, a price or a ledger figure
