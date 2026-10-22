Feature: Staff can read every submission and share a link to any CRM item
  A prospect or review record opened in Pipeline shows everything the visitor submitted, and every
  item has an address that opens the board with that item's details.

  Background:
    Given an authenticated member of the configured Prospectus workspace

  Scenario: A prospect shows the contact email and every inquiry, newest first
    Given a prospect with a contact email, a company and two inquiries received at different times
    When the member opens the prospect in Pipeline
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
    When the member opens it in Pipeline
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

  Scenario: Every item has a shareable address
    When the member selects an item on the board
    Then the address becomes /pipeline/ followed by the item's issue ID
    And the detail panel offers Copy link, which copies the full https address of that item
    When the member closes the panel
    Then the address returns to the Pipeline page

  Scenario: An item address opens the board with its details
    When the member opens /pipeline/ followed by an issue ID
    Then Pipeline opens with that item's detail panel, even when the item is not among the listed cards
    And browser back and forward move between the items the member opened

  Scenario: An address for a missing item reports it
    When the member opens /pipeline/ followed by an unknown issue ID
    Then Pipeline opens with a message that the item could not be found

  Scenario: Signing in returns to the shared item
    Given a visitor who is not signed in opens /pipeline/ followed by an issue ID
    When the visitor signs in with Google
    Then the Cognito redirect still returns to /auth/callback
    And afterwards the address is /pipeline/ followed by the same issue ID with its details open

  Scenario: Only internal paths are used as the sign-in return target
    Given a saved return target that is an absolute URL, a protocol-relative URL, a backslash path or the callback path
    When sign-in completes
    Then the visitor lands on the home page instead

  Scenario: Signed-in people without access see only access pending
    Given a signed-in person without workspace access opens /pipeline/ followed by an issue ID
    Then they see Workspace access pending
    And no CRM record is requested

  Scenario: The hosting rewrite serves item addresses
    Given the Amplify custom rule in infra/hosting-settings.json
    Then /pipeline/ followed by an issue ID is rewritten to /index.html with status 200
    And static assets are still served as files
