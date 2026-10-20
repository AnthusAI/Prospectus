Feature: A website inquiry becomes an actionable private prospect
  Scenario: Capture a synthetic demo request
    Given the local review form and an empty real Kanbus project
    When a visitor submits a valid example.invalid demo inquiry
    Then one prospect retains contact, trusted source, receipt and inquiry time
    And it has an owner, response action and next business day follow-up
    And the visitor receives a receipt without CRM details or credentials

  Scenario: Deduplicate delivery and contact identity
    Given concurrent inquiries with the same normalized email
    When distinct submissions and a retried delivery are accepted
    Then one prospect retains each distinct inquiry exactly once
    And its existing stage, owner, next action and notes are preserved
    And retrying after intake restart resolves to the same prospect

  Scenario: Share identity across independent workers
    Given separate receipt ledgers using one conditional identity control store
    And both workers initially read an empty supplemental contact catalog
    When both accept requests for the same normalized email
    Then one immutable creation intent and backend operation are shared
    And one canonical prospect retains both inquiries exactly once
    And another worker can recover lost claim, creation, completion and append responses
    And a receipt ledger or supplemental catalog rebuild does not drop the identity claim

  Scenario: Route control operations through scoped S3 transport
    Given a fixed trusted workspace, bucket and region
    When an identity or receipt control is read or conditionally written
    Then the private bridge uses Virtuus S3 absent or revision conditions without changing bytes
    And a conditional conflict differs from an uncertain write result
    And a lost response does not cause a blind transport retry
    And unauthorized workspace or arbitrary journal routing is denied before storage access
    And service-mock acceptance does not enable production intake

  Scenario: Preserve an uncertain backend write
    Given a backend write committed but its response was lost
    When the same receipt is processed after restart
    Then the exact saved operation is replayed without a duplicate prospect

  Scenario: Constrain the local public boundary
    Given the synthetic-only loopback transport
    When a request contains unknown fields, a real email, a wrong origin or an oversized body
    Then no prospect is created
    And anonymous CRM reads remain denied
    And the production frontend does not include the local intake form

  Scenario: Fail closed instead of risking duplicate or unjournaled writes
    Given a stale worker lock or failed receipt storage
    When intake is opened or another submission is attempted
    Then no unsafe automatic lock takeover or unjournaled backend write occurs
    And manual local recovery is required
    Given an operation conflict rather than a revision conflict
    When an inquiry write is rejected
    Then its original write intent is retained without minting another operation

  Scenario: Never turn away a valid inquiry
    Given a well-formed submission from a visitor
    When the canonical API fails, the contact is duplicated, its identity changed or its history is full
    Then the full inquiry is already stored in the intake inbox and the visitor receives 202 with the receipt
    And a repeat contact with a new submission id appends to the same prospect fetched by id, not from a search hit
    And data problems are filed as a needs-review prospect with no follow-up
    And an operator can retry pending inbox items idempotently

  Scenario: Work the next action and hand off the customer
    Given an assigned active prospect with a due next action
    When its owner opens due follow-ups and corrects contact details
    Then the action is visible and editable and closed records are excluded
    And contact changes preserve inquiry provenance
    When the prospect becomes a customer
    Then an owner, next action and follow-up are required
    And the same issue and history remain available after reload

  Scenario: Preserve the private member write transport
    Given the browser sends X-Operation-Id and If-Match on member writes
    When its configured origin requests a write preflight
    Then those headers are allowed in the reviewed infrastructure template
    And issue routes continue to require JWT and workspace membership

  Scenario: Describe a demo request honestly as a follow-up request
    Given a submitted demo inquiry
    When the visitor views its receipt
    Then it is described as a follow-up request awaiting a reply
    And it states that no appointment or meeting time has been booked
