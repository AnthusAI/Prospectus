Feature: Operator billing in the CRM
  Operators handle a client's billing from the account's page under Usage and billing in the CRM admin
  workspace. Admins holding accounts:admin:billing see the actions; operators with read access see the same
  information without them. The server refuses every action from anyone else, whatever the page shows.

  Scenario: Account billing overview
    Given an operator with accounts:admin:read and accounts:admin:billing opening the account "Example Press"
    Then they see the billing profile, each site deployment's line with plan, status and period
    And open invoices with balances and due dates, recent payments and the journal timeline

  Scenario: Read-only operator
    Given an operator with accounts:admin:read only
    Then the same overview is shown
    And no action to record a payment, allocate, write off or raise an invoice is shown

  Scenario: Account with no profile
    Given an account with no billing profile
    Then the page says the account is not yet billable
    And an admin sees Set up billing profile

  Scenario: Raise an invoice
    When the admin adds lines, keeps the net 30 due date and issues the invoice via Stripe or manually
    Then the invoice appears with its number, balance and issue method

  Scenario: Download an invoice PDF
    Given an issued invoice
    When the operator chooses Download PDF
    Then the invoice PDF downloads

  Scenario: Record and allocate a payment
    When the admin records a check and allocates it across two invoices
    Then both balances update and the payment shows no remainder

  Scenario: Over-allocation is blocked in the form
    When the admin enters allocations larger than an invoice balance or the payment amount
    Then the form blocks submission before any request and names the limit

  Scenario: Money inputs are integer-safe
    When the admin types 1234.56 as an amount
    Then it is sent as 123456 cents
    And an amount with more than two decimal places is refused in the form

  Scenario: Reverse a payment
    When the admin reverses a payment with a reason
    Then the reversal shows in the timeline with the actor and the reason

  Scenario: Write off an invoice
    When the admin marks an invoice uncollectible with a reason
    Then its status shows as uncollectible and it stays listed with its journal entries

  Scenario: Billing never offers to suspend
    Given an invoice that is past due
    Then the page shows the follow-up
    And disabling the product is offered only through the existing entitlement action

  Scenario: No customer data leaks
    Then billing contact fields are masked until revealed
    And nothing billing-related is logged in the browser console

  Scenario: Actions use buttons and Lucide icons
    Then each billing action is a button, not a dropdown item
    And icons are Lucide icons with no emoji

  Scenario Outline: Billing pages work on phone and desktop in both color schemes
    Given the billing page at <width> pixels in <mode> mode
    Then the page content does not overflow horizontally
    And focus is visible on tables, forms and buttons
    Examples:
      | width | mode  |
      | 375   | light |
      | 1440  | dark  |
