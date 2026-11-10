Feature: Invoiced engagements
  An engagement is services work Anthus does for one account, invoiced by Anthus. Most engagements are ongoing:
  a monthly amount with no end date until someone ends it. A setup package has a price, a length in weeks and
  stages. Engagements are billing records in the account's serialized ledger, so every write is an admin's,
  carries an operation ID, compares revisions and writes exactly one journal event. Invoice lines name the
  engagement they bill, which is how Prospectus knows when an engagement was last invoiced and which month is
  still waiting for an invoice. Issuing an invoice stays a person's decision.

  Background:
    Given an account "Example Press" with an invoiced billing profile
    And an operator holding the accounts:admin:billing grant

  Scenario: Start an ongoing engagement
    When the admin starts an ongoing engagement "Reporting desk support" led by "Example Lead" from 2026-10-01 at 1000000 cents a month
    Then billing/engagements/<uuid>.json holds the account, name, lead, start date, monthly amount and status active
    And it has no end date
    And the journal records engagement.created
    And the account's engagements list it

  Scenario: Start a setup package
    When the admin starts a setup package "Newsroom setup" from 2026-10-26 for 6 weeks at 1200000 cents
    Then its end date is 2026-12-07 and its stage is Installation
    When the admin moves it to the Training stage
    Then its stage is Training and the journal records engagement.updated

  Scenario: A proposed engagement starts later
    When the admin records a proposed engagement
    Then it is listed as proposed and offers no invoice line
    When the admin starts it
    Then it is active

  Scenario: End an engagement
    Given an active ongoing engagement
    When the admin ends it on 2026-12-31
    Then its status is ended with end date 2026-12-31 and the journal records engagement.ended
    And any further change to it is refused as engagement_ended

  Scenario: Writes are reviewed and replay safely
    When an operator without accounts:admin:billing starts or changes an engagement
    Then it is refused and nothing is written
    When the same start is sent twice with one operation ID
    Then one engagement exists and the replay returns the original
    When a change carries a stale expected revision
    Then it is refused as revision_conflict

  Scenario: Engagement fields are checked
    When an ongoing engagement has no positive monthly amount, or a setup package has no price or length
    Then it is refused naming the field and nothing is written
    And amounts are whole cents in US dollars

  Scenario: An invoice line bills an engagement
    Given an active ongoing engagement "Reporting desk support"
    When the admin raises an invoice whose line names the engagement
    Then the invoice line keeps the engagement ID
    And the engagement shows that invoice as last invoiced, with its number, issue date and service dates

  Scenario: An already-sent invoice bills an engagement
    Given an active ongoing engagement
    When the admin enters an invoice sent outside Prospectus with a line naming the engagement
    Then the engagement shows it as last invoiced

  Scenario: Only the account's own started engagements are billed
    When an invoice line names an engagement of another account, a proposed engagement or no engagement that exists
    Then the invoice is refused as invalid_engagement and nothing is written

  Scenario: A month waiting for an invoice
    Given an active ongoing engagement started 2026-10-01
    And its last invoice was issued 2026-10-31
    When the console is read on 2026-12-05
    Then the engagement shows November 2026 as not yet invoiced
    And Today lists a follow-up to invoice it
    When an invoice naming the engagement is issued on 2026-12-02
    Then nothing is waiting

  Scenario: Raise an invoice from an engagement
    Given an active ongoing engagement and an active setup package on the account
    When the admin opens Raise an invoice for the account
    Then each is offered under Add from this account
    And choosing the ongoing one adds "<name>, monthly retainer" at its monthly amount for the chosen service dates
    And choosing the setup package adds the package once at its price
    And the added line names its engagement, including for an invoice already sent outside Prospectus

  Scenario: The Engagements page
    When the member opens Engagements
    Then each engagement shows its kind, account, lead, dates, stage or last invoiced, and amount
    And the filters are Active, Ongoing, Setup packages and Proposed, with counts
    And an admin can start a new engagement as Ongoing or Setup package
    And the Account page lists the account's engagements and the Accounts page counts them
