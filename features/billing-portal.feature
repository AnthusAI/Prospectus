Feature: Plan and billing in the Anthus One portal
  Account owners see what each of their site deployments and other products cost, their invoices and what
  they still owe, and can pay or update their card from Plan and billing. The portal only reads the ledger;
  every payment action leaves for Stripe and returns to one.anth.us, so no card or bank details touch it.

  Scenario: Direct-mode account
    Given an owner of a direct-mode account with two active lines
    When they open Plan and billing
    Then both deployments are listed with plan and next charge
    And invoices are listed with status, balance and a PDF download
    And Manage billing opens the Stripe customer portal
    And Pay now appears on an open Stripe-issued invoice and opens Stripe's hosted invoice page

  Scenario: Pending line
    Given an owner of a direct-mode account with a pending line and no subscription
    Then Set up billing is shown
    When they choose it
    Then the browser is sent to Stripe Checkout and returns to one.anth.us

  Scenario: One invoice per period
    Given an owner of an account with three billing lines
    Then each period shows one invoice with one line item per deployment or product

  Scenario: Invoiced account
    Given an owner of an invoiced-mode account
    Then the page lists invoices with due dates and balances
    And shows the payment instructions the admin set on the profile
    And shows Pay now only for invoices issued via Stripe

  Scenario: Partially paid invoice
    Given an invoice of 120000 with 50000 allocated
    Then the owner sees it as partially paid with 700.00 USD still due

  Scenario: Member or viewer
    Given a member or viewer of the account
    When they open Plan and billing
    Then they see that billing is managed by the account's owners
    And no amounts are shown

  Scenario: No profile
    Given an account with no billing profile
    Then the page says billing is not set up for this workspace and how to ask Anthus

  Scenario: Customers cannot write to the ledger
    Given a signed-in owner
    When they try to change the profile, a line, an invoice or a payment through the portal API
    Then the request is refused and nothing is written

  Scenario: Never card data
    Then the portal collects no card or bank details
    And the page loads no Stripe script

  Scenario Outline: Plan and billing works on phone and desktop in both color schemes
    Given Plan and billing at <width> pixels in <mode> mode
    Then the page content does not overflow horizontally
    And focus is visible on links and buttons
    Examples:
      | width | mode  |
      | 375   | light |
      | 1440  | dark  |
