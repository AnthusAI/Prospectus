Feature: Apps send usage through per-product SQS queues
  Each registered product has its own queue, so the queue proves which product sent a message. A scheduled
  consumer drains every queue once a minute into the ledger and the quota. Recording never sits on an app's
  request path.

  Background:
    Given the product "papyrus-example" is registered with a quota caller role
    And the usage queues are enabled in the deployment

  Scenario: Queues are generated from the registry
    When the infrastructure is synthesized
    Then each registered product has one usage queue and one dead-letter queue
    And each queue policy allows sqs:SendMessage from exactly that product's role and nothing else
    And an alarm fires when any dead-letter queue holds a message

  Scenario: Disabled by default
    Given the usage queues flag is off
    When the infrastructure is synthesized
    Then it is byte for byte what it was before cost accounting

  Scenario: The product comes from the queue, never the message
    Given a message on papyrus-example's queue whose body names another product
    When the consumer drains it
    Then it is refused with wrong_product and nothing is charged

  Scenario: A valid message is recorded
    Given a message {version: 1, operationId, accountId, app: "papyrus", deployment: "example", day, items: [{itemKind, quantity}]}
    When the consumer drains it
    Then the ledger records the estimate and the quota week is charged
    And the message is deleted from the queue

  Scenario: A malformed message goes to the dead-letter queue
    Given a message that is not valid JSON or has unknown fields
    When the consumer drains it
    Then nothing is charged, the refusal is logged with a reason code only, and after the retry limit it lands in the dead-letter queue

  Scenario: An unknown Account is refused
    Given a message naming an Account that does not exist or is not entitled to the product
    Then it is refused and nothing is charged

  Scenario: Prospectus unavailable
    Given the ledger store cannot be written
    When the consumer runs
    Then the messages stay on the queue and are retried on a later run with the same operation IDs

  Scenario: Bounded runs
    When the consumer runs
    Then it reads at most a configured number of messages per queue per run and finishes within its timeout
