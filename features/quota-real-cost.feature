Feature: The weekly quota is drawn against real cost
  Quota units are microdollars of real cost. A plan names a monthly cost budget and each quota week allows a
  quarter of it. Customers still see only the percent used.

  Scenario: Weekly allowance is a quarter of the monthly budget
    Given a private table whose plan "standard" has monthlyBudgetMicrodollars 40000000
    Then an Account on "standard" has a weekly allowance of 10000000 microdollars

  Scenario: A monthly budget that does not divide by four
    Given a plan with monthlyBudgetMicrodollars 10000001
    Then the weekly allowance is 2500000, rounded down

  Scenario: Tables written before the change still parse
    Given a table whose plans carry weeklyAllowanceUnits
    Then the weekly allowance is that value, unchanged

  Scenario: A plan names exactly one allowance
    Given a plan with both weeklyAllowanceUnits and monthlyBudgetMicrodollars, or neither
    Then the table is unparseable and every quota call answers quota_unavailable

  Scenario: The ledger charges the quota
    Given an Account at 0 percent with a weekly allowance of 10000000
    When the ledger records 2500000 microdollars of cost for it
    Then the Account's quota shows 25 percent used

  Scenario: A correction lowers usage
    Given an Account with 3000000 used this week
    When an imported actual corrects an estimate by -500000
    Then 2500000 is used, and usage never goes below zero

  Scenario: Costs with no use
    Given nobody used the app on a day
    When the daily import charges that day's hosting cost
    Then the percentage goes up even though no product reported usage

  Scenario: Refusal at 100 percent is unchanged
    Given an Account at 100 percent
    Then check answers not allowed and new reservations are refused until the week resets
