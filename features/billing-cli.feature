Feature: Record and allocate payments from the prospectus CLI
  Ryan wants agents to record payments for him. An agent signs in with `prospectus login --remote` as an
  admin and uses the billing commands. The server checks accounts:admin:billing on every call, so the CLI
  gains no authority the CRM pages lack. Specs use a fake API with no network.

  Scenario: List invoices with balances
    Given an admin CLI session
    When the agent runs prospectus billing invoices --account <account> --status partially_paid
    Then it lists that account's partially paid invoices with number, total, balance and due date

  Scenario: Show an invoice and download its PDF
    When the agent runs prospectus billing invoice show <number>
    Then it prints the invoice with its line items and allocations
    When the agent runs prospectus billing invoice pdf <number> -o invoice.pdf
    Then the invoice PDF is written to invoice.pdf

  Scenario: Record a payment split across two invoices
    Given two issued invoices with balances 60000 and 40000
    When the agent runs prospectus billing payment record --account <account> --amount 1000.00 --method bank_transfer --received 2026-11-03 --reference EX-123 --allocate <first>=600.00 --allocate <second>=400.00 --yes
    Then one payment of 100000 cents is recorded with two allocations
    And both invoices show as paid

  Scenario: The CLI confirms before writing
    When the agent records a payment without --yes
    Then the CLI prints the account, amount, method, received date and allocations it will record
    And writes nothing until confirmed

  Scenario: Allocate a remainder later
    Given a recorded payment with 30000 unallocated
    When the agent runs prospectus billing payment allocate <payment> <number>=300.00 --yes
    Then the payment has no remainder and the invoice balance falls by 30000

  Scenario: Write off an invoice
    When the agent runs prospectus billing invoice write-off <number> --reason "Client closed" --yes
    Then the invoice is uncollectible and stays on record

  Scenario: Amounts are parsed into integer cents
    When the agent passes --amount 12.345 or --amount -5.00
    Then the CLI refuses it before any request

  Scenario: Only external methods
    When the agent passes --method stripe_card
    Then the CLI refuses it and says Stripe payments arrive by webhook

  Scenario: A retried command records once
    Given a payment record command whose response was lost
    When the same command is retried with the same operation id
    Then one payment exists

  Scenario: Over-allocation is refused with a clear message
    When the agent allocates more than an invoice balance or the payment amount
    Then the CLI prints the refusal naming the limit and nothing is written

  Scenario: Wrong account is refused
    When the agent allocates a payment to an invoice of another account
    Then the CLI prints the refusal and nothing is written

  Scenario: A non-admin session is refused
    Given a CLI session for a staff member without accounts:admin:billing
    When they record or allocate a payment or write off an invoice
    Then the CLI prints that billing admin permission is required and nothing is written
