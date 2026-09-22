@subagents @draft @SA-05
Feature: Retain agent evidence without continuing execution after exit
  As a user,
  I want predictable shutdown and restoration,
  so that saved conversations do not imply hidden background execution.

  @ACC-SA-05-01 @confirmed
  Scenario: Stop managed child execution when pi exits.
    Given pi owns a running child session and its managed tools support cancellation.
    When the user exits pi.
    Then the child session and its managed tool execution stop.
    And the child is not moved to a detached supervisor to continue after exit.
    And available saved conversation and output remain eligible for later inspection.

  @ACC-SA-05-02 @proposed
  Scenario Outline: Stop departing-session children without transferring ownership.
    Given the current parent session owns active child runs.
    When the user <operation>.
    Then those child runs are stopped under the shutdown policy.
    And any newly activated parent session does not inherit control of those agents.
    And no saved child execution restarts automatically.

    Examples:
      | operation                        |
      | reloads extensions               |
      | starts a new parent session      |
      | switches to another session      |
      | forks the parent session         |

  @ACC-SA-05-03 @proposed @recovery
  Scenario: Restore records without replaying work.
    Given a parent session has saved completed and cancelled agents.
    When the user restores that parent session.
    Then the agents and their retained outcomes are available in the inspector.
    And no child provider request occurs until an explicit eligible launch or resume is accepted.

  @ACC-SA-05-04 @proposed @recovery
  Scenario: Classify execution left unfinished by a dead process.
    Given a previous owning process has been proven dead.
    And one of its child runs has no recorded terminal outcome.
    When the owning parent session is restored.
    Then the run is reported as interrupted rather than completed.
    And its available output is retained.
    And the task is not automatically replayed.

  @ACC-SA-05-05 @proposed @concurrency
  Scenario: Refuse concurrent control of the same parent's agents.
    Given one live Secretary controller owns a parent's child sessions.
    When another process attempts to control those same child sessions.
    Then the second process reports an ownership conflict.
    And it cannot start or resume those agents concurrently.

  @ACC-SA-05-06 @proposed
  Scenario: Do not grant control through a known name from another session.
    Given parent session A owns an agent named "reviewer".
    And parent session B does not own that agent.
    When session B tries to message or stop session A's agent by its name or identifier.
    Then the operation is rejected.
    And session A's execution is unchanged.

  @ACC-SA-05-07 @proposed @recovery
  Scenario: Avoid replaying an uncertain completion notification.
    Given a background run has finished and completion delivery is recorded as uncertain.
    And the parent transcript contains that delivery's stable identifier.
    When delivery is reconciled after restoration.
    Then the recorded transcript evidence is recognized.
    And no duplicate automatic follow-up turn is requested for the same completion.

  @ACC-SA-05-08 @proposed
  Scenario Outline: Retain execution history without presenting abandoned work as current work.
    Given a parent session owns a <state> agent.
    When the user navigates to a branch before that agent was launched.
    Then the agent is excluded from the current context and fleet.
    And any unfinished abandoned execution receives a cancellation request.
    And finished statuses, output, usage, and filesystem effects are not rolled back.
    And historical launch calls are not executed again.
    And a new launch can reuse the abandoned agent's name without reusing its execution.
    And returning to the original branch shows its retained execution history.

    Examples:
      | state    |
      | running  |
      | finished |
