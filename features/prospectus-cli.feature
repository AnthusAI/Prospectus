Feature: The prospectus command
  An admin, or an agent working for one, signs in from a terminal and does billing work without the browser.
  Sign-in follows the Papyrus and Cyclotron pattern: cli-login's remote sign-in through prospectus.anth.us,
  each login enrolled with Accounts like a browser sign-in, and the session kept only in the machine's secure store.
  The server checks the operator's billing permission on every call; the command adds no authority of its own.

  Background:
    Given prospectus.anth.us publishes its CLI discovery document

  Rule: Signing in

    Scenario: Remote sign-in prints the approval link and enrolls the login
      When I run "prospectus login --as ryan@example.com"
      Then it prints an approval URL on prospectus.anth.us and a matching code
      And after the person approves, the login is enrolled at the Accounts identity service
      And the session is stored in the secure store
      And it prints "Signed in as ryan@example.com."

    Scenario: A login that cannot be enrolled stores nothing
      Given the Accounts identity service refuses the enrollment
      When I run "prospectus login"
      Then it says why the login could not be enrolled
      And nothing is stored

    Scenario: Status reads only the local session
      Given I am signed in
      When I run "prospectus auth status"
      Then it shows who is signed in and prints no tokens

    Scenario: Logout removes the session and revokes it
      Given I am signed in
      When I run "prospectus logout"
      Then the local session is removed and the refresh token is revoked

    Scenario: Commands need a session
      Given I am not signed in
      When I run "prospectus billing invoices"
      Then it says to run "prospectus login"

  Rule: Reading billing

    Scenario: Listing invoices with balances
      Given I am signed in as a billing admin
      When I run "prospectus billing invoices --account 'Data Parade'"
      Then it lists each invoice's number, issue date, due date, status, total and balance

    Scenario: An account is named by its name or its ID
      When I name an account that matches no account, or more than one
      Then it says so and lists the candidates, and nothing is sent

  Rule: Recording payments

    Scenario: Recording a payment and applying it to an invoice
      Given invoice 202610-001 has a balance of $10,000.00
      When I run "prospectus billing payment record --account 'Data Parade' --amount 10000 --method melio --received 2026-11-10 --apply 202610-001 --yes"
      Then one payment of 1000000 cents by Melio, received 2026-11-10, is recorded
      And 1000000 cents are applied to invoice 202610-001
      And the request carries a fresh operation ID

    Scenario: A payment split across two invoices
      When I apply "202610-001=4000" and "202611-001=6000"
      Then the payment is applied to both invoices in those amounts

    Scenario: Writes are confirmed before they are sent
      When I record a payment without "--yes"
      Then it prints what it will record and asks before sending
      And without a terminal to ask on, it refuses and sends nothing

    Scenario: Amounts are dollars, read exactly
      Then "10000", "10,000.00" and "$10,000" are all 1000000 cents
      And "10.001", "0" and "-5" are refused

    Scenario: Refusals come back in the server's words
      Given the server refuses because I am not a billing admin
      When I record a payment
      Then it prints the server's message and exits non-zero
