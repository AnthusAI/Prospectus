Feature: Prospectus uses the shared organizer components
  Scenario: Synthetic LAN review uses the same board and detail surface as marketing
    Given a synthetic inquiry is submitted twice with the same normalized email
    When I open the LAN synthetic workspace
    Then one prospect retains both inquiries and an owner and dated next action
    And the board uses the optional shared organizer theme
    When I select its card with the keyboard
    Then the shared detail surface opens with the CRM editing content
    When I save its next action and move through the allowed stages to Customer success
    And reload the page
    Then the same customer and updated action remain

  Scenario Outline: Organizer CRM works on mobile and desktop
    Given the synthetic workspace at <width> pixels in <mode> mode
    Then the first board column is initially visible
    And page content does not overflow horizontally
    And card focus is visible
    And reduced motion disables shared transitions
    Examples:
      | width | mode  |
      | 375   | light |
      | 1024  | dark  |
