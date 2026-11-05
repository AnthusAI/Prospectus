Feature: Anthus products are listed in one order and shown with their own branding
  The staff console and the customer portal list Anthus products from one catalog. Each product shows its
  own logo and nothing invented. Auritus and Babulus are one product, Babulus.

  Scenario: Products are listed in one order everywhere
    Given the Anthus product catalog lists products by how likely they are to sell
    When any console or portal screen lists products
    Then they appear in the catalog order, which is the only place the order is written
    And at the time of writing that order is Papyrus, Cyclotron, Chatticus, Babulus, then Kanbus, Apricity and Professional services
    And no product is removed

  Scenario: Auritus and Babulus are one product
    Given Auritus was merged into Babulus on 2026-11-02 and the combined product is called Babulus
    When the catalog lists products
    Then it lists Babulus once, at https://babul.us, and does not list Auritus
    And the blurb is the Babulus one about voiceover and video made locally first

  Scenario: Older Auritus identifiers keep displaying
    Given an account entitlement, product name or stored prospect interest that still says auritus
    When the console or portal shows it
    Then it is shown as Babulus and opens https://babul.us
    And the stored value is not rewritten by reading it
    And an interest saved before the merge as auritus is shown as Babulus without a duplicate

  Scenario: Lead capture never rejects older values
    Given contact, waitlist and demo intake
    When a message names Auritus
    Then it is accepted and filed like any other
    And intake validation never depends on the product catalog

  Scenario: Products show their own logo
    Given a product whose logo is published in a public MIT-licensed Anthus repository
    When it is shown in a chip, list, tile or navigation link
    Then its real logo image is shown, with a light and a dark variant
    And a product without a vetted logo shows a neutral mark with no product color
    And no logo is invented, redrawn or copied from a private repository or a GPL repository
    And every shipped logo file records its source repository, path and license
