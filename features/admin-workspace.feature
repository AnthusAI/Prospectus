Feature: Anthus One admin workspace for Prospectus
  Anthus staff sell and serve from one admin shell: Today, Pipeline and Accounts.
  Screens follow the Anthus One design. Areas without a backend yet are shown as not yet available
  rather than with made-up numbers.

  Background:
    Given an authenticated member of the configured Prospectus workspace

  Scenario: The admin shell groups work into sell, serve and admin
    When the member opens the application
    Then the header identifies Anthus One with an "Admin · Prospectus" mark
    And the navigation lists Today and Pipeline under Sell
    And Accounts, Engagements and Usage and billing under Serve
    And Anthus team and Settings under Admin
    And the current page is marked with aria-current
    And the chosen page is kept in the address so reload returns to it

  Scenario: Today lists the member's own follow-ups by urgency
    Given active prospects assigned to the member with follow-up dates before, on and after today
    And a prospect assigned to someone else
    When the member opens Today
    Then follow-ups are grouped as Overdue, Today and This week
    And only the member's active prospects appear
    And each row shows the next action, company, contact, stage and due date
    And the follow-up count in the navigation matches the rows due today or earlier

  Scenario: Completing a follow-up asks for the next one
    Given a follow-up on Today
    When the member marks it done
    Then its prospect opens in Pipeline with the next action and follow-up date ready to change
    And nothing is saved until the member saves a new next step

  Scenario: New website inquiries can be taken from Today
    Given a prospect in the initial stage with a website inquiry, owned by someone else
    When the member chooses Take it
    Then the prospect is reassigned to the member with its current revision
    And a competing edit is reported as a conflict instead of overwriting it

  Scenario: Pipeline uses the shared Kanbus board with the Anthus One theme
    When the member opens Pipeline
    Then the shared Kanbus board shows one column per configured stage
    And the member can filter to their own prospects
    And search in the header filters prospects by the shared Kanbus query
    And collapsed columns survive switching between board and list and reloading

  Scenario: The prospect drawer edits stage, owner, next step and interests
    Given a prospect in the Proposal stage
    When the member selects it on the board
    Then the shared detail surface opens with its reference, source, company and contact
    And the stage bar shows every configured stage, allowing only the configured transitions
    When the member chooses Customer success, changes the next action and adds Papyrus as an interest
    And saves changes
    Then the same issue ID keeps the new stage, next action and interests after reload

  Scenario: Mark lost closes a prospect in one step
    Given an active prospect open in the drawer
    When the member chooses Mark lost
    Then the prospect moves to the closed stage without requiring a follow-up date

  Scenario: Accounts lists every account for central account administrators
    Given the member holds the central Accounts administrator permission
    When the member opens Accounts
    Then each account shows its name, active members and app entitlements
    And plan, quota, services and Anthus owner show as not yet available
    And filters that need billing data are shown but disabled

  Scenario: Staff without the administrator permission see no accounts
    Given the member lacks the central Accounts administrator permission
    When the member opens Accounts
    Then the page says the central administrator permission is required
    And no account, including ones the member belongs to, is listed
    And CRM administrator status does not grant the account directory

  Scenario: People without staff access never see the admin console
    Given a signed-in person who is not a member of the Prospectus workspace
    When they open the application
    Then they see only the access-pending screen with refresh and sign-out
    And no admin navigation, page or accounts view is rendered, even before access is known

  Scenario: An account page shows entitlements, members and its record
    Given the member holds the central Accounts administrator permission
    When the member opens an account from Accounts
    Then the page shows its apps with capability codes, its memberships with roles and statuses
    And its account ID can be copied and its record version is shown
    And quota, services engagements and history show as not yet available
    And the page states that staff access is read-only and not a membership

  Scenario: Areas without a backend say so
    When the member opens Engagements, Usage and billing, Anthus team or Settings
    Then the page explains that the area is not yet available
    And no invented figures are shown

  Scenario Outline: The admin shell works on phone and desktop in both color schemes
    Given the workspace at <width> pixels in <mode> mode
    Then the page content does not overflow horizontally
    And text meets 4.5:1 contrast
    And focus is visible on navigation, cards and buttons
    Examples:
      | width | mode  |
      | 375   | light |
      | 1440  | dark  |
