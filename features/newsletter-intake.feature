Feature: Newsletter mailing lists with double opt-in
  Anthus sites send newsletter signups to Prospectus. A subscription is active only after the
  person confirms from the email we send, every list email can be left with one click, and an
  unsubscribe is honoured forever. Starts with the Papyrus newsletter on https://p.apyr.us.

  Scenario: Declare a newsletter in the registry
    Given a registry entry of kind newsletter with a site, form id, notice version, owner, origins and a list block naming the list, its site, its privacy page and its sender address
    When the registry is loaded
    Then the list gets its own route POST /intake/newsletter/<formId>
    And the entry may not declare attributes and may not be named confirm or unsubscribe
    And its sender address must be on a shipped mail domain
    And one site may share one origin between one waitlist, one contact form and one newsletter
    And an entry with enabled false adds no route, origin, permission, mail domain or secret

  Scenario: Accept only the newsletter fields
    Given the Papyrus newsletter papyrus-newsletter-v1
    When a visitor sends email, submission_id, website, notice_version, page_path and optional elapsed_ms and campaign
    Then the signup is validated with the same strictness as the other registry forms
    And an unknown field, a malformed email or receipt, an invalid page path or campaign, or a stale notice version is a 400 and nothing is stored

  Scenario: Always the same answer, so the response never reveals an address
    Given a new address, an address already pending, an address already subscribed, an unsubscribed address and a filled honeypot
    When each one signs up
    Then every response is 202 with the receipt and "Check your inbox to confirm your subscription."
    And the response body and headers are identical apart from the receipt

  Scenario: Store first, then process
    Given the Papyrus newsletter
    When a valid signup arrives
    Then a subscription record for the list and the normalized email is stored before any email is sent or the CRM is touched
    And it records the request time, notice version, source page and campaign and never an IP address
    And a CRM or email failure after the store still answers 202
    And only a failure to store anything answers 503 so the visitor can retry

  Scenario: Double opt-in
    Given a new signup that is not likely spam
    When it is stored
    Then one confirmation email is sent from the list's sender with a link carrying a signed token that expires after 7 days
    And the subscription stays pending, and no other list email may go to it, until the person confirms
    And the confirmation link opens a page whose button confirms, so a mail scanner that fetches the link confirms nothing
    And confirming makes the subscription active with the confirmation time and notice version
    And confirming again shows the same page and changes nothing

  Scenario: Tokens are signed, bound and expiring
    Given a token signing secret in an SSM SecureString created once by a create-only custom resource
    Then a confirm token verifies only for its own purpose, list and subscription, before it expires
    And a tampered, truncated, expired, unknown-list or wrong-purpose token shows a "link is not valid" page and changes nothing
    And the token never contains the email address

  Scenario: Limit confirmation resends
    Given a pending subscription whose confirmation was sent less than 24 hours ago
    When the same address signs up again
    Then no email is sent and the response is the same 202
    And after 24 hours a new signup sends one more confirmation

  Scenario: Likely spam gets no email
    Given a signup with the honeypot filled or otherwise scored likely spam
    When it is stored
    Then it is stored with its spam result and no email is sent
    And if the same address later signs up cleanly and confirms, the confirmation is honoured

  Scenario: One-click unsubscribe
    Given any list email
    Then it carries List-Unsubscribe with an HTTPS unsubscribe link and List-Unsubscribe-Post "List-Unsubscribe=One-Click" (RFC 8058)
    When the mail client posts to that link, or the person opens it and presses Unsubscribe
    Then a permanent suppression for the list is written and the subscription is marked unsubscribed
    And repeating the request shows the same result and writes nothing new
    And opening the link with GET alone unsubscribes nobody

  Scenario: Suppression is honoured forever
    Given an address that unsubscribed from a list
    When it signs up again or an old confirmation link is used
    Then the response is the same 202 and no email is sent and the subscription stays unsubscribed
    And the suppression is kept by a hash of the address, so it survives deletion of the subscription record
    And hard bounces and complaints are suppressed for every list by the SES account suppression list through the configuration set

  Scenario: CRM visibility without a prospect per subscriber
    Given a prospect already exists for the subscriber's email
    When the subscription is requested, confirmed or unsubscribed
    Then the prospect shows the list, its status and its consent times
    And a subscriber with no prospect does not get one

  Scenario: Origin binding both ways
    Given the newsletter route allows only https://p.apyr.us
    When https://p.apyr.us posts to the demo route or another origin posts to the newsletter route
    Then the request is rejected with 403 before any service is opened

  Scenario: Sending as infrastructure as code
    Given an enabled newsletter form
    When the backend is synthesized
    Then it has an SES domain identity for news.apyr.us with Easy DKIM, a custom MAIL FROM domain and a configuration set that suppresses bounces and complaints
    And Route 53 has the three DKIM CNAMEs, the MAIL FROM MX and SPF records and a DMARC record in the apyr.us zone
    And the intake role may send only from the list sender through that identity and configuration set, read only the token parameter and read and write only the newsletter control prefix
    And nothing else gains a permission

  Scenario: Export confirmed subscribers
    Given operator credentials
    When the export script runs
    Then it prints counts per list and status only
    And with an explicit output file it writes the confirmed, unsuppressed subscribers with their consent times
