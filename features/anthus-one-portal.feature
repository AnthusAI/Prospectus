Feature: Anthus One customer portal at one.anth.us
  Customers open their Anthus apps, see their workspaces and members, and manage settings in one place.
  The portal is a separate application from the Prospectus staff console: its own page, code, build and
  address. It shares only the central account service and the Anthus One visual design.
  Areas without a backend yet (quota, usage, plans and billing, API keys, invitations, workspace creation)
  say so instead of showing invented figures.

  Scenario: The portal is a separate application from the staff console
    Given the Prospectus repository
    When the portal is built
    Then it produces its own bundle from its own entry page
    And that bundle contains no CRM, pipeline or operator directory code
    And the staff console bundle contains no portal code

  Scenario: Signing in with Google
    Given a visitor who is not signed in
    When they open the portal
    Then they see the Anthus One sign-in page with Continue with Google
    When they complete Google sign-in
    Then they return to the portal, never to the staff console
    And the portal shows that sign-in is finishing until the session is ready
    And the portal never shows the sign-in page again after Google redirects back

  Scenario: Confirming the account identity
    Given a signed-in person whose Google sign-in has not been confirmed with the account service
    When they open the portal
    Then they are asked to confirm with Google once
    And no workspace data is shown until confirmation succeeds

  Scenario: A person with no workspace
    Given a confirmed person who belongs to no workspace
    When they open the portal
    Then it says they have no workspace yet and how to get one
    And creating a workspace is shown as not yet available

  Scenario: Choosing a workspace
    Given a confirmed person who belongs to two workspaces
    When they open the portal
    Then the header lets them choose between those two workspaces only
    And the chosen workspace is kept in the address

  Scenario: Home lists the workspace's apps
    Given a workspace with active Papyrus and Cyclotron entitlements
    When its member opens Home
    Then Your apps shows Papyrus and Cyclotron with their addresses and Open links
    And the quota, activity and service status panels say they are not yet available

  Scenario: Apps shows every Anthus app and which ones the workspace has
    When a member opens Apps
    Then each Anthus app is listed as on, off or not available to the workspace
    And turning apps on or off is not offered until the account service supports it

  Scenario: People shows members according to role
    Given an owner or admin of a workspace
    When they open People and bots
    Then they see every membership with its role and status
    And invitations say they are not yet available
    Given a member who is not an owner or admin
    When they open People and bots
    Then they see only their own membership and that admins can see the rest

  Scenario: Settings shows the workspace record
    When a member opens Settings
    Then they see the workspace name, ID and creation date
    And appearance follows the system or a chosen light or dark theme
    And quota alerts, API keys, security and deletion say they are not yet available

  Scenario: Unbuilt areas say so
    When a member opens Usage, Plan and billing or API keys
    Then the page explains that it is not yet available
    And no invented figures are shown

  Scenario Outline: The portal works on phone and desktop in both color schemes
    Given the portal at <width> pixels in <mode> mode
    Then the page content does not overflow horizontally
    And focus is visible on navigation, links and buttons
    Examples:
      | width | mode  |
      | 375   | light |
      | 1440  | dark  |
