Feature: Stripe through one payment processor boundary
  Everything that talks to Stripe goes through one PaymentProcessor interface. Every spec runs against an
  in-memory fake that mirrors Stripe's documented shapes, so billing is built before any Stripe account
  exists. In direct mode each client has one Stripe Subscription with one item per billing line, and
  Stripe produces one invoice per client per period. Card data never reaches Prospectus, and billing
  never changes access on its own.

  Scenario: No network in specs
    When the billing specs run
    Then no HTTPS call leaves the process and no Stripe key is read

  Scenario: The fake mirrors Stripe's shapes
    Given the fake processor
    When a customer, subscription with items, invoice and payment intent are created
    Then ids use Stripe's prefixes cus_, sub_, si_, in_, pi_ and evt_
    And amounts are integer minor units in usd
    And subscriptions move through incomplete, active, past_due and canceled
    And invoices move through draft, open, paid, void and uncollectible

  Scenario: Webhook signature and deduplication
    Given a signing secret generated in the test
    When a payload is signed with Stripe's v1 scheme within the 300-second tolerance
    Then it is accepted and applied once
    When the same event id is delivered again
    Then it is a no-op
    When a payload is tampered with, unsigned or has a stale timestamp
    Then it is refused with 400 and nothing is written

  Scenario: Webhook abuse
    When the webhook receives a body over the limit or an unknown event type
    Then it is refused with 400 and nothing is written
    And the route is throttled

  Scenario: Out-of-order deliveries converge
    When invoice.paid arrives before invoice.finalized for the same invoice
    Then the ledger ends in the same state as for in-order delivery

  Scenario: An event for an unknown account
    When an event names a Stripe customer that no profile holds
    Then it is refused and logged with a reason code only

  Scenario: Switching to real Stripe
    Given billing/deployment.json with Stripe enabled in test mode and both parameters present
    When the processor is constructed
    Then the Stripe implementation is used with the restricted key
    When a parameter is missing or too short
    Then billing fails closed with 503 billing_unavailable

  Scenario: Stripe customer on first need
    Given a direct-mode profile with no Stripe customer
    When the first billing line is created or the owner starts Checkout
    Then one Stripe customer is created with the account UUID in metadata and its id stored on the profile
    And a retry reuses it

  Scenario: Checkout creates the client's one subscription
    Given a direct-mode account with two pending lines and no subscription
    When the owner chooses Set up billing in the portal
    Then the portal BFF creates one Checkout session in subscription mode with one item per pending line
    And success and cancel URLs are on one.anth.us
    And no card data touches Prospectus

  Scenario: One subscription per client, one item per line
    When Stripe sends checkout.session.completed and customer.subscription.updated with status active
    Then the account has one subscription
    And each line becomes active with its own subscription item id and period
    And the journal records each event once

  Scenario: Adding a deployment adds an item
    Given a direct-mode account with an active subscription
    When an admin creates a line for a third site
    Then an item is added to the existing subscription and no second subscription is created

  Scenario: Ending one deployment
    Given a subscription with items for two sites
    When an admin ends one site's line
    Then only that item is removed and the other site is still billed
    When the last line on the subscription is ended
    Then the subscription is cancelled

  Scenario: One subscription invoice mirrored per period
    When invoice.finalized then invoice.paid arrive for the client's subscription
    Then one ledger invoice with issuedVia stripe holds one line item per subscription item, with Stripe's total
    And a stripe_card or stripe_bank payment is recorded and allocated to it by the stripe-webhook actor

  Scenario: Payment failed does not suspend
    When invoice.payment_failed arrives
    Then the invoice shows as past due in the ledger
    And a billing follow-up is created for operators
    And every entitlement is unchanged

  Scenario: Unpaid past Stripe's retries still does not suspend
    When customer.subscription.updated reports past_due and later customer.subscription.deleted
    Then follow-ups are created for operators
    And no entitlement is disabled by billing

  Scenario: Stripe refund mirrored as a reversal
    When charge.refunded arrives for a mirrored payment
    Then a reversing payment and reversing allocation are written with reversal_of
    And the invoice balance and status are restored

  Scenario: Manage payment method
    When the owner chooses Manage billing
    Then a Stripe customer portal session is created and the browser is sent there

  Scenario: Least privilege
    Then the billing runtime role reads and writes only prospectus-central/billing/* and its control files
    And reads only the two Stripe parameters
    And it cannot read identities, accounts or intake prefixes
    And the accounts runtime cannot write billing

  Scenario: No secrets or contact data in logs
    When the billing tests run
    Then captured logs contain no key material, signing secret, card or bank fragment, email, name or address
