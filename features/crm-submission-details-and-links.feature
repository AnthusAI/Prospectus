Feature: Staff can read every submission and share a link to any CRM item
  A prospect or review record opened as a lead page shows everything the visitor submitted, and every
  item has an address that opens the board with that item's details.

  Background:
    Given an authenticated member of the configured Prospectus workspace

  Scenario: A prospect shows the contact email and every inquiry, newest first
    Given a prospect with a contact email, a company and two inquiries received at different times
    When the member opens the prospect's lead page
    Then the contact email is a mailto link
    And each inquiry shows its kind, received time in local time, name, email, company and full message
    And the newer inquiry is listed before the older one
    And line breaks in each message are preserved

  Scenario: An inquiry shows where it came from and what the visitor agreed to
    Given an inquiry from the anthus-website with a page path, campaign values, a notice version and attributes
    When the member opens the prospect
    Then the source page links to https://anth.us with that page path
    And the campaign values, marketing opt-in, notice version and attributes are listed
    And the first source, latest source, next action and follow-up date are listed

  Scenario: A review record explains why it needs review
    Given a record labelled needs-review with a review reason, a review contact email and a related issue
    And the record has no contact email
    When the member opens its lead page
    Then a banner reads "Needs review" followed by the reason
    And the banner links to the related item
    And the review contact email is shown as a mailto link
    And its inquiry and full message are shown

  Scenario: Submitted text is never interpreted as markup
    Given an inquiry whose message contains a script tag, an HTML image and a markdown link
    When the member opens the prospect
    Then the message text is shown literally
    And no script, image or link is created from the message
    And an inquiry page path that is not on the same site is not turned into a link

  Scenario: Every lead has its own page and a shareable address
    When the member opens a lead from Today or Pipeline
    Then the address becomes /pipeline/ followed by the lead's issue ID
    And the lead opens as a full page, not as a panel over the board
    And a breadcrumb links back to Pipeline
    And the page offers Copy link, which copies the full https address of that lead
    When the member follows the Pipeline breadcrumb
    Then the address returns to /pipeline

  Scenario: A lead page shows everything the staff need to work the lead
    When the member opens a lead page
    Then it shows the lead's contact, company, email and source
    And it shows the full text of every inquiry with its source
    And it shows who owns the lead, with a way to assign it or take it
    And it offers stage changes, the next action and the follow-up date
    And it shows the Spam check section with the Not spam, Spam and Vendor buttons
    And it shows the submission details, the comments and the conversation history
    And saving, adding a note and moving the stage work exactly as they did in the former drawer
    And a competing edit is reported as a conflict with a way to reload the latest record, never overwritten

  Scenario: Taking a lead from its page
    Given a lead owned by someone else
    When the member chooses Take it on the lead page
    Then the lead is reassigned to the member with its current revision

  Scenario: A lead address opens the lead page
    When the member opens /pipeline/ followed by an issue ID on a fresh visit
    Then the lead page opens, even when the lead is not among the listed cards
    And the browser tab is titled with the lead's company or name
    And browser back and forward move between the leads and pages the member opened

  Scenario: Spam-hidden leads still open by their direct link
    Given a lead labelled likely spam
    Then it is not listed on Today and is hidden by default in Pipeline
    But /pipeline/ followed by its issue ID opens its lead page with the Spam check section

  Scenario: An address for a missing lead reports it
    When the member opens /pipeline/ followed by an unknown issue ID
    Then the page says the item could not be found, with a link back to Pipeline
    And the address stays as the member opened it

  Scenario: Signing in returns to the shared page
    Given a visitor who is not signed in opens a console address such as /pipeline/ followed by an issue ID or /accounts/ followed by an account ID
    When the visitor signs in with Google
    Then the Cognito redirect still returns to /auth/callback
    And afterwards the address is the same path with its page open

  Scenario: Only known console paths are used as the sign-in return target
    Given a saved return target that is an absolute URL, a protocol-relative URL, a backslash path, the callback path, a path the console does not route or a path carrying sign-in parameters
    When sign-in completes
    Then the visitor lands on the home page instead
    And a target that is a known console path is kept, without any query string

  Scenario: Signed-in people without access see only access pending
    Given a signed-in person without workspace access opens /pipeline/ followed by an issue ID
    Then they see Workspace access pending
    And no CRM record is requested

  Scenario: The hosting rewrite serves item addresses
    Given the Amplify custom rule in infra/hosting-settings.json
    Then /pipeline/ followed by an issue ID and every other extensionless console path is rewritten to /index.html with status 200
    And static assets are still served as files
