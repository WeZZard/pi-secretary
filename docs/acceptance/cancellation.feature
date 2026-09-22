@subagents @draft @SA-04
Feature: Cancel selected work without losing evidence
  As a user or parent agent,
  I want to stop selected execution without stopping unrelated work,
  so that cancellation preserves control and available evidence.

  @ACC-SA-04-01 @proposed
  Scenario: Cancel a queued run before it starts.
    Given an accepted child run is waiting for execution capacity.
    When the parent requests "TaskStop" for that run.
    Then the run is reported as cancelled.
    And the run never submits a provider request.
    And unrelated queued and running agents remain unchanged.

  @ACC-SA-04-02 @proposed
  Scenario: Distinguish a stop request from observed termination.
    Given a child is running a controlled tool that has not yet responded to cancellation.
    And the child has already produced output and changed a file.
    When the parent requests "TaskStop" for that child.
    Then the run is reported as stopping rather than already cancelled.
    And its output and file changes remain available.
    When termination is observed.
    Then the run is reported as cancelled.
    And it does not restart automatically.

  @ACC-SA-04-03 @proposed @concurrency
  Scenario: Name the execution identity observed when a stop is requested.
    Given the user presses the stop shortcut for a selected running execution.
    And the request is submitted without a confirmation step.
    When that run finishes before the request reaches the service.
    And a new run starts for the same agent.
    Then the newer run is not stopped.
    And the recorded request retains the identity it captured.

  @ACC-SA-04-04 @proposed
  Scenario: Interrupt a foreground launch while preserving its outcome.
    Given a foreground "Agent" call owns a queued or running child.
    When the parent cancels that foreground tool call.
    Then cancellation is requested for its captured child run.
    And unrelated child runs are not cancelled.
    And the eventual outcome remains available through inspection or output retrieval.
    And the interrupted foreground response does not trigger an automatic completion turn after the user abort.

  @ACC-SA-04-05 @proposed @concurrency
  Scenario: Preserve successful completion when foreground cancellation arrives too late.
    Given a foreground child's successful outcome has already been recorded.
    When the foreground caller is cancelled before receiving that outcome.
    Then the recorded child outcome remains successful.
    And the result remains available for inspection.
    And the cancellation does not overwrite the recorded outcome or restart the child.

  @ACC-SA-04-06 @proposed
  Scenario: Cancel an output wait without cancelling execution.
    Given a child is running.
    And "TaskOutput" is waiting for that child's captured run.
    When the parent cancels the output wait.
    Then the wait ends.
    And the child continues running.
    And its eventual result remains available.

  @ACC-SA-04-07 @proposed
  Scenario: Keep a noncooperative execution unavailable for resumption.
    Given a child tool remains active after cancellation is requested.
    When the cleanup deadline expires without observed settlement.
    Then the interface reports that termination has not been confirmed.
    And the child is not reported as successfully completed.
    And its worktree is retained.
    And resumption is refused while the previous runner may still be active.

  @ACC-SA-04-08 @proposed @SA-12
  Scenario: Stop one nested agent from its drill level.
    Given agent A launched nested agent B and nested agent C through the delegation contract.
    And agent B launched nested agent D through the delegation contract.
    And the fleet view overlay is drilled into A's level.
    When the user stops B.
    Then B is reported as cancelled.
    And D is cancelled with B.
    And A and C continue running.
    And the request retains the identity it captured.
