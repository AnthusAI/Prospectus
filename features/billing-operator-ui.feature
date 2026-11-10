Feature: Operator billing in the CRM
  Operators handle a client's billing from the account's page under Usage and billing in the CRM admin
  workspace. Admins holding accounts:admin:billing see the actions; operators with read access see the same
  information without them. The server refuses every action from anyone else, whatever the page shows.

  The billing ledger and its operator routes are not built yet (kanbus-ffdad5, kanbus-0f125f). Until they are,
  a signed-in operator sees the billing pages as not yet available, and the console never invents figures.
  Synthetic review mode shows every screen with a fixture of fictional clients so the pages can be reviewed
  and tested. The fixture is not part of the production bundle.

  Scenario: Billing routes are not deployed
    Given a signed-in operator and a deployment with no billing routes
    When they open Usage and billing, an account's Billing tab, an invoice, Record a payment, Raise an invoice or Billing settings
    Then each page says billing is not yet available and shows no amounts
    And no billing action is offered
    And the console makes no billing request and logs nothing

  Scenario Outline: Each billing page has its own shareable address
    Given the address <path>
    When it is opened directly on a fresh visit, signed in or after signing in
    Then that page loads, without first opening another page
    Examples:
      | path                          | page                              |
      | /invoices/202610-003          | the invoice                       |
      | /invoices/new                 | Raise an invoice                  |
      | /payments/<paymentId>         | the payment                       |
      | /payments/new                 | Record a payment                  |
      | /accounts/<accountId>/billing | the account's Billing section     |
      | /settings/billing             | Billing settings                  |

  Scenario: Billing addresses survive sign-in
    Given a signed-out visitor opens a billing address
    When they sign in
    Then they return to that same address
    And an address that does not match a billing pattern exactly is not accepted as a return target

  Scenario: Billing addresses work with the browser history and as links
    When the operator moves between billing pages and goes back and forward
    Then each step shows the page at that address
    And every invoice, payment and account in a table is a real link that opens in a new tab
    And the existing ?view= addresses keep working

  Scenario: Account billing overview
    Given an operator with accounts:admin:read and accounts:admin:billing opening the account "Example Press"
    Then they see the billing profile, each site deployment's line with plan, status and period
    And open invoices with balances and due dates, recent payments and the journal timeline

  Scenario: Read-only operator
    Given an operator with accounts:admin:read only
    Then the same overview is shown
    And no action to record a payment, allocate, write off or raise an invoice is shown

  Scenario: Usage and billing across accounts
    Given an operator opening Usage and billing
    Then they see what is outstanding, what is past due, what was collected this month and what is not yet applied
    And a Needs attention list that links to the invoice, account or payment and never changes anyone's access
    And how old the open balance is, in not yet due, 1 to 30, 31 to 60 and over 60 days past due
    And tabs for Invoices, Payments and By account, with invoice filters for Open, Past due, Partly paid, Paid, Void or written off and All
    And a wide table scrolls inside its own box instead of the page

  Scenario: Account page sections
    Given an operator opening an account
    Then Overview and Billing are separate sections of the account page
    And the Overview shows a billing summary with Owed, Past due, Not yet applied and Last payment and a link to the Billing section
    And the Billing section has its own address so it can be linked

  Scenario: Accounts list shows what is owed
    Given an operator opening Accounts
    Then each account has an Owed amount with a note of how much is past due
    And a Past due filter lists only accounts with an invoice past its due date and a balance

  Scenario: Today shows what billing needs
    Given an invoice is past due or a payment is not fully applied
    Then Today shows a Past due total and billing follow-ups that open the invoice or the payment
    And a billing follow-up is derived from the records, so it needs no stored follow-up

  Scenario: Past due is derived
    Given an invoice with a balance and a due date before today
    Then it is past due, and the days late are counted from the due date
    And an invoice with no balance, a void invoice or a written-off invoice is never past due
    And no past due status is stored

  Scenario: Account with no profile
    Given an account with no billing profile
    Then the page says the account is not yet billable
    And an admin sees Set up billing profile

  Scenario: Starting a billing profile takes the billing contact
    Given an account with no billing profile
    When the admin chooses Set up billing profile
    Then the form asks how they pay, the terms, and the billing contact's name and email, with an optional postal address
    And saving without the contact's name and email is refused in the form, naming what is missing
    And saving with them starts the profile with that contact

  Scenario: Billing waits for sign-in
    Given a staff member returning from Google sign-in straight onto a billing or engagements address
    Then billing loads once the sign-in completes, without asking them to sign in again

  Scenario: Raise an invoice
    When the admin adds lines, keeps the net 30 due date and issues the invoice via Stripe or manually
    Then the invoice appears with its number, balance and issue method

  Scenario: One invoice per period
    Given an account that already has an invoice for November
    When the admin raises another invoice for the November period
    Then the form refuses it and names the existing invoice
    And Anything else remains available for an extra charge

  Scenario: Invoice lines are checked before issuing
    When a line has no description, a quantity that is not a whole number of at least 1, or a unit price with more than two decimal places
    Then the form names the problem and does not issue
    And the total is the sum of quantity times unit price in integer cents

  Scenario: The sender choice
    Given Stripe is not connected
    Then the Stripe sender option is disabled and says it is not connected yet
    And no Stripe key is entered or shown anywhere on a billing page

  Scenario: Draft and issue
    When the admin saves the invoice as a draft
    Then the draft is saved without a number
    When the admin issues it
    Then it is numbered and can no longer be edited

  Scenario: View an invoice
    Given an issued invoice
    Then the page shows its status, whether it is past due, who sent it, total, paid, credits and balance
    And how the balance got here, listing each record that changed it, who made it and the balance after
    And the invoice as sent, with the issuer, bill to and payment methods copied when it was issued
    And an invoice with payments applied cannot be voided and says why

  Scenario: Record an invoice already sent outside Prospectus
    Given an admin raising an invoice for an invoiced account
    When they tick "Already sent outside Prospectus" and enter the number 202610-001 and an October 2026 issue date
    Then the invoice is recorded with that number and issue date, due net terms after it, and no draft is offered
    And a number whose year and month differ from the issue date is refused in the form before any request

  Scenario: The billing permission does not wait for the billing lists
    Given an admin with accounts:admin:billing whose billing lists are slow or fail to load
    Then billing settings are editable as soon as the permission is confirmed

  Scenario: Download an invoice PDF
    Given an issued invoice
    When the operator chooses Download PDF
    Then the invoice PDF downloads

  Scenario: Record and allocate a payment
    When the admin records a check and allocates it across two invoices
    Then both balances update and the payment shows no remainder

  Scenario: Allocate the remainder of a payment later
    Given a payment with an unallocated remainder
    When the admin chooses Allocate
    Then the form opens for that payment with the remainder as the amount to apply

  Scenario: Oldest first
    When the admin chooses Oldest first
    Then the payment is applied to the oldest invoices first, each up to its balance

  Scenario: Over-allocation is blocked in the form
    When the admin enters allocations larger than an invoice balance or the payment amount
    Then the form blocks submission before any request and names the limit

  Scenario: Money inputs are integer-safe
    When the admin types 1234.56 as an amount
    Then it is sent as 123456 cents
    And an amount with more than two decimal places is refused in the form

  Scenario: View a payment
    Given a recorded payment
    Then its page shows the amount, method, reference, who recorded it, what it was applied to and what is not yet applied
    And an admin can allocate the remainder or reverse it from that page

  Scenario: Reverse a payment
    When the admin reverses a payment with a reason
    Then the reversal shows in the timeline with the actor and the reason

  Scenario: Write off an invoice
    When the admin marks an invoice uncollectible with a reason
    Then its status shows as uncollectible and it stays listed with its journal entries

  Scenario: Billing never offers to suspend by hand
    Given an invoice that is past due
    Then the page shows the follow-up and the line's billing standing
    And read-only access follows from the standing alone (features/billing-standing.feature)
    And disabling the product outright is offered only through the existing entitlement action

  Scenario: Billing settings
    Given an operator opening Settings
    Then they see the issuer block, the accepted payment methods, the default terms and the next invoice number
    And what is set elsewhere: Stripe, plans and prices, and who can change billing
    And an admin can edit and save them, while a read-only operator can view them and is told changing needs the billing permission
    And a saved change applies to new invoices only

  Scenario: Read-only is the default
    Given the operator's billing permission cannot be read
    Then the pages are read-only

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
