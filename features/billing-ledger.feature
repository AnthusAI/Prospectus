Feature: Invoice ledger with partial payments
  Admins raise invoices for anything, record payments that arrive by bank transfer, check or other means,
  and apply them to invoices in pieces. Each client gets one combined invoice per period, with each billing
  line as its own line item. Amounts are integer cents in US dollars, with no tax lines. Issued records are
  never edited; corrections are reversal records. Every mutation writes exactly one journal event.

  Background:
    Given an account "Example Press" with an invoiced billing profile
    And an operator holding the accounts:admin:billing grant

  Scenario: Raise and issue an invoice
    When the admin creates a draft with lines of description, quantity, unit amount in cents and optional billing line and period
    And issues it
    Then billing/invoices/<uuid>.json holds subtotal, total and a balance equal to the total
    And the total equals the subtotal with no tax lines
    And its status is issued with the next number from the invoice sequence
    And the journal records the draft and the issue

  Scenario: Net 30 due date
    Given the profile has no net terms override
    When an invoice is issued on 2026-11-02
    Then its due date is 2026-12-02
    And no late fee is ever added

  Scenario: Per-account net terms override
    Given the profile overrides net terms to 15 days
    When an invoice is issued on 2026-11-02
    Then its due date is 2026-11-17

  Scenario: Only US dollars
    When an admin creates an invoice or records a payment in a currency other than usd
    Then it is refused and nothing is written

  Scenario: One combined invoice per client per period
    Given the account has active lines for two Papyrus sites and Cyclotron Lab
    When the admin raises the November period invoice
    Then one invoice holds three line items, one per billing line
    When the admin raises another period invoice for November
    Then it is refused

  Scenario: Issue through Stripe
    Given a profile with a Stripe customer and the processor enabled
    When the admin issues the invoice via Stripe
    Then a Stripe invoice with collection_method send_invoice is created from the same lines and due date
    And its id is stored as the external reference
    And later Stripe payments reach the ledger only through the webhook mirror

  Scenario: Issue manually
    Given a profile with no Stripe customer
    When the admin issues the invoice manually
    Then it is issued with issuedVia manual and no external call is made

  Scenario: Every invoice has a PDF
    Given an issued manual invoice and an issued Stripe invoice
    Then each can be downloaded as a PDF rendered from its ledger record

  Scenario: Invoice numbers are sequential within each month and never reused
    Given no invoice has been issued in October 2026
    When two invoices are issued at the same moment on 2026-10-31
    Then they are numbered 202610-001 and 202610-002, with no duplicate
    When the next invoice is issued on 2026-11-02
    Then it is numbered 202611-001
    When an issued invoice with no allocations is voided
    Then its status is void, its balance is zero and its number is not reused

  Scenario: Issuer details and payment methods come from data
    Given an admin set the issuer record with a legal name, an address, and bank transfer and Melio payment methods
    And the Melio instructions hold an https payment link
    When an invoice is issued
    Then the invoice record carries a copy of that issuer block and those payment methods, and its PDF shows them
    And the PDF makes the https payment link clickable
    When the admin later changes the issuer address
    Then the issued invoice and its PDF still show the address it was issued with
    And no issuer name, address, payment detail or payment link appears in the repository

  Scenario: Payment links are https only
    When an admin sets payment instructions that contain an http, javascript, data, mailto or other non-https link
    Then the issuer record is refused and nothing is written

  Scenario: Melio payments are recorded like any external payment
    When an admin records a payment with method melio
    Then it is recorded, and a payment with method venmo recorded earlier stays valid

  Scenario: Issued invoices are immutable
    Given an issued invoice
    When anyone tries to edit its lines
    Then it is refused
    And a correction is a new invoice or a credit that references it

  Scenario: Integer arithmetic
    Given lines with quantities and unit amounts in cents
    Then totals are integer cents that sum exactly
    And no floating point is used anywhere in billing

  Scenario: Record an external payment
    Given an issued invoice with balance 120000
    When the admin records a bank transfer of 50000 with a reference and received date
    Then billing/payments/<uuid>.json exists with unallocated 50000, recorded by the admin's grant id
    And the journal records it

  Scenario: Partial payment moves the invoice to partially_paid
    Given that payment of 50000 and the invoice with balance 120000
    When the admin allocates 50000 of the payment to the invoice
    Then an allocation record exists
    And the invoice balance is 70000 and its status partially_paid
    And the payment's unallocated amount is zero

  Scenario: Several payments move the invoice from partially_paid to paid
    Given the partially paid invoice with balance 70000
    When payments of 30000 and 40000 are recorded and allocated to it
    Then the balance is zero, the status is paid and the paid date is set
    And the invoice lists its three allocations

  Scenario: One payment pays several invoices
    Given a check for 90000 and three issued invoices of 30000 each
    When it is allocated 30000 to each
    Then all three are paid and the payment has no remainder

  Scenario: Over-allocation is refused
    When an allocation exceeds the invoice balance or the payment's unallocated amount
    Then it is refused and nothing is written

  Scenario: Concurrent allocations cannot exceed a payment
    Given a payment with 50000 unallocated
    When two admins each allocate 40000 of it at the same moment
    Then one allocation succeeds and the other is refused as over-allocation

  Scenario: Reversing a bounced check
    Given a check of 30000 allocated to an invoice that is now paid
    When the admin reverses the payment with a reason
    Then a reversing payment and a reversing allocation are written, each with reversal_of naming the original
    And the invoice returns to its previous balance and status
    And the original payment and allocation are untouched

  Scenario: Stripe payments cannot be recorded by hand
    When an admin tries to record a payment with method stripe_card or stripe_bank
    Then it is refused
    And Stripe-collected money enters the ledger only through the webhook mirror

  Scenario: Write-off by admins only
    Given an issued invoice with an unpaid balance
    When an admin marks it uncollectible
    Then its status is uncollectible and the invoice and its journal entries stay on record
    When an operator holding only accounts:admin:read, or an account owner, tries the same
    Then the response is 403 forbidden and nothing is written

  Scenario: Only billing admins write to the ledger
    Given an operator holding only accounts:admin:read, or a signed-in account owner
    When they raise an invoice, record a payment, allocate, reverse or void
    Then the response is 403 forbidden and nothing is written

  Scenario: No second-operator confirmation
    When an admin records an external payment of any amount
    Then it is recorded without another operator's confirmation

  Scenario: Replayed writes are recorded once
    Given a payment record whose response was lost
    When the same operation id is sent again
    Then the original payment returns and no second payment exists

  Scenario: Past-due follow-up for a manual invoice
    Given a manual invoice with a balance whose due date has passed
    When the daily due-date check runs
    Then the invoice shows as past due
    And a billing follow-up appears in the CRM Serve queue with the invoice number, balance and days overdue
    And no entitlement changes

  Scenario: Follow-up on an ended line
    When a line is ended or a subscription is cancelled
    Then a follow-up asks the operator whether to disable the product through the entitlement route

  Scenario: Reconcile against Stripe
    Given the processor enabled in test mode
    When an operator runs scripts/reconcile-billing.ts with their own credentials
    Then by default nothing is written
    And it lists ledger records whose Stripe counterpart differs in amount or status, Stripe objects with no ledger record and payments with unallocated remainders
    And it prints counts and ids only

  Scenario: The journal is complete
    Given any billing mutation
    Then exactly one journal event exists for it with actor, operation id, record kind and revisions
    And every balance can be rebuilt from the journal

  Scenario: Enter an invoice that was issued outside Prospectus
    Given the issuer record is set
    When the admin enters an issued invoice with the number 202610-001, an issue date in October 2026 and its line items
    Then the invoice is issued with that number and a due date of net terms after its issue date
    And the October sequence counter moves past 001, so the next October invoice is 202610-002
    When the admin enters another invoice with the number 202610-001
    Then it is refused as a taken number and nothing is written
    When the admin enters an invoice whose number month differs from its issue date
    Then it is refused

  Scenario: A draft can be voided and frees its period
    Given a draft period invoice for November 2026
    When the admin voids the draft
    Then its status is void, it has no number, and the admin can raise a new invoice for November

  Scenario: Credits reduce an invoice balance
    Given an issued invoice of 120000 with a payment of 50000 allocated
    When the admin records a credit of 20000 with a reason
    Then a credit record names the invoice and the balance is 50000
    When the credit exceeds the balance
    Then it is refused and nothing is written
    And a credited invoice cannot be voided

  Scenario: Written-off balances stay separate from outstanding
    Given a written-off invoice with 70000 unpaid
    Then it keeps its unpaid figure, is not counted as open, and is listed as uncollectible
    And no allocation, credit or second write-off is accepted for it

  Scenario: A voided invoice's allocations must be reversed first
    Given an invoice with a reversed payment
    Then it has no net allocations and can be voided
    Given an invoice with a live allocation
    Then voiding it is refused

  Scenario: Different request, same operation id
    Given an operation id already used for one request
    When it is sent with a different request
    Then the response is 409 idempotency_conflict and nothing is written

  Scenario: Stale revisions are refused
    Given an invoice or payment read at revision 3 that has since changed
    When an admin allocates, reverses, voids, writes off or credits with expectedRevision 3
    Then the response is 409 revision_conflict and nothing is written

  Scenario: Interrupted operations finish
    Given an operation that wrote some of its records and then stopped
    When any other operation on the account starts
    Then the interrupted operation is completed first, exactly once, and its journal event exists

  Scenario: Read access follows the grants
    Given an operator holding only accounts:admin:read
    Then they can read invoices, payments, the journal and the issuer, with the billing contact masked
    And an account owner or a member without any operator grant can read nothing from the operator billing routes
    And revealing the billing contact is a write that needs accounts:admin:billing and is journaled

  Scenario: The operator billing routes are off by default
    Given billing/deployment.json holds ledger.enabled false
    Then every operator billing route answers 404 and no billing storage is opened
    And the routes are served only when the flag is true and billing storage is configured

  Scenario: The PDF is rendered from the issued record
    Given an issued invoice
    Then its PDF is a valid PDF built without a browser, from the issuer block and payment methods copied at issue
    And a draft has no PDF

  Scenario: The staff BFF forwards the operator billing routes
    Given the ledger is enabled and a staff session
    When the console calls a billing route through the BFF
    Then the BFF checks the origin of writes and the session as for every route, and forwards to central
    And central's refusal is returned with its code and message
    And a path the BFF does not list, or a customer session, gets the usual 404
    And no billing contact and no PDF byte is ever logged

  Scenario: The invoice PDF crosses the BFF as binary
    Given an issued invoice
    When the console asks for its PDF through the BFF
    Then the response is application/pdf, base64 encoded for API Gateway, with a filename and no caching
    And a PDF above 4,000,000 bytes is refused by central as 413 pdf_too_large, below the 6 MB Lambda response limit once base64 is added

  Scenario: One reviewed flag turns billing on everywhere
    Given billing/deployment.json holds ledger.enabled false
    Then the synthesized infrastructure is byte for byte what it was before billing existed
    And the console build ignores VITE_BILLING_ROUTES and shows billing as not yet available
    When a reviewed change sets ledger.enabled true
    Then the central runtime role gains the two billing S3 prefixes, the staff BFF role and the API access policy gain the ten write routes, and the console calls the routes
