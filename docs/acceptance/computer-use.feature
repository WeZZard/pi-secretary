@computer-use @draft
Feature: Delegate a desktop task to the computer-use agent
  As a parent agent,
  I want to hand a desktop task to the computer-use agent and receive facts about what it did,
  so that the task runs in a disposable machine and my conversation stays free of per-step details.

  # These scenarios run live: Pi loads the extension, the real planner and executor decide, and the
  # task runs in a relay machine. Results are recorded in docs/testing/computer-use-verification.md.

  @ACC-CU-01 @confirmed @CU-01 @CU-02 @CU-05 @CU-06
  Scenario: A delegated task completes with a compact report and steps checked by code.
    Given Calculator is open with a cleared display in a relay machine.
    When the parent delegates "compute 7 + 3 in Calculator" to the computer-use agent.
    Then the run is reported as succeeded.
    And the last plan completed, and each of its steps was verified by code.
    And the display shows "10" when the task's check reads it.
    And the report the parent receives states the result "10".
    And the parent's conversation contains no observation or element table of any step.
    And every step of the last plan names the relay steps that hold its screenshots.

  @ACC-CU-02 @confirmed @CU-05
  Scenario: A result already on screen is not reported as the agent's work.
    Given Calculator is open and already shows "10" in a relay machine.
    When the parent delegates "make Calculator show 10" to the computer-use agent.
    Then no plan sends an action.
    And the report the parent receives says that the result was already on screen.

  @ACC-CU-03 @confirmed @CU-03
  Scenario: A control that does not exist stops the task with a named reason.
    Given Calculator is open in a relay machine.
    When the parent delegates "press the Launch Rocket button in Calculator" to the computer-use agent.
    Then no plan completes.
    And no step sends an action.
    And the report the parent receives says that the button was not found.

  @ACC-CU-04 @confirmed @CU-04
  Scenario: A destructive step that the task did not authorize is refused before any input.
    Given TextEdit shows its dialog asking whether to keep an unsaved new document, in a relay machine.
    When the parent delegates "close the document" without authorizing deleting or discarding anything.
    Then no step sends an action that was judged destructive.
    And every step judged destructive stopped with the reason "approval_required".

  @ACC-CU-05 @confirmed @CU-07
  Scenario: A task whose application is not open stops, and the agent launches nothing.
    Given no application is opened in the relay machine.
    When the parent delegates "compute 7 + 3 in Calculator" to the computer-use agent.
    Then Calculator is not running when the task's check reads it.
    And the report the parent receives says that Calculator is not open.

  @ACC-CU-06 @confirmed @CU-03
  Scenario: An unavailable decision service stops the task, and the planner does not act.
    Given Calculator is open in a relay machine.
    And the decision service cannot be reached.
    When the parent delegates "compute 7 + 3 in Calculator" to the computer-use agent.
    Then every plan that ran escalated with the reason "executor_unavailable".
    And no step sent an action.

  @ACC-CU-07 @confirmed @PS-D11
  Scenario: The main agent has no computer tools, and the machine is released before the run ends.
    Given any scenario of this feature ran.
    When its runs have ended.
    Then the parent never called "computer_observe" or "computer_run_plan".
    And every relay lease of the run has a lifecycle record that says it was released.
    And each lease was released before the run that used it was recorded as ended.

  @ACC-CU-08 @confirmed @PS-D11 @SA-04
  Scenario: A cancelled run releases its machine before it is reported cancelled.
    Given the computer-use agent is running a task in a relay machine.
    When the parent stops it with "TaskStop".
    Then the run is reported as cancelled.
    And its relay lease has a lifecycle record that says it was released.
    And the lease was released before the run was recorded as ended.
