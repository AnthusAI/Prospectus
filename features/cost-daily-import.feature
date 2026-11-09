Feature: Daily import of real AWS costs
  Once a day Prospectus reads yesterday's cost from Cost Explorer, grouped by anthus:cost-key and service, records
  it in the ledger as actuals, splits shared costs by reported usage, and charges the current quota week. Specs run
  against a fake Cost Explorer with no network.

  Scenario: Tagged per-customer costs
    Given Cost Explorer reports 350000 microdollars of AWS AppSync for cost key "<uuid>/papyrus/example" on 2026-11-09
    When the import runs on 2026-11-10
    Then the ledger records an actual of 350000 for that Account, app "papyrus", deployment "example", category "aws.appsync" on 2026-11-09

  Scenario: Shared costs are split by reported usage
    Given Cost Explorer reports 900 microdollars of AWS Lambda for cost key "shared/cyclotron/" on 2026-11-09
    And on that day app "cyclotron" reported 2000 GB-seconds for Account A and 1000 for Account B
    When the import runs
    Then Account A is charged 600 and Account B 300
    And the split rounds so the parts sum to exactly 900

  Scenario: Shared cost with usage of the app but not of that service
    Given shared AWS Lambda cost for app "cyclotron" and no aws.lambda usage reported that day
    But Accounts reported other usage of "cyclotron" that day
    Then the cost is split by each Account's total reported usage of the app

  Scenario: The real figure replaces the live estimate
    Given the app reported aws.appsync.requests for an Account, priced as an estimate
    When the import records that Account's actual for aws.appsync
    Then the estimate no longer counts and only the actual is charged

  Scenario: Shared cost with no reported usage
    Given shared cost for app "cyclotron" on a day with no reported usage of the app
    Then it is recorded as unattributed overhead for that app and charged to no Account

  Scenario: Untagged cost
    Given cost with no anthus:cost-key
    Then it is recorded as untagged overhead for that day, by service, and charged to no Account

  Scenario: Unknown Accounts and credits
    Given a cost key naming an Account that does not exist, or a negative amount
    Then it is recorded as overhead and charged to no Account

  Scenario: Costs not yet final
    Given Cost Explorer marks the day's figures as estimated
    When the import runs
    Then it records them, and a later import for the same day replaces them

  Scenario: Re-running is safe
    When the import runs twice for the same day
    Then the second run changes nothing

  Scenario: Costs count in the current week
    Given the cost was incurred on Friday 2026-11-13 and imported on Sunday 2026-11-15
    Then it is charged to the quota week that started on Saturday 2026-11-14

  Scenario: A failed Cost Explorer call
    Given Cost Explorer returns an error
    Then the import records nothing, logs a reason code and retries on its next run
