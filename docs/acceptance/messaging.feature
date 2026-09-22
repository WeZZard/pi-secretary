@subagents @draft @SA-03
Feature: Guide and resume an existing agent
  As a user or parent agent,
  I want to address the same agent conversation throughout its lifecycle,
  so that guidance does not accidentally create unrelated or concurrent work.

  @ACC-SA-03-01 @proposed
  Scenario: Acknowledge queued guidance without claiming compliance.
    Given a resumable agent named "reviewer" is running a controlled tool operation.
    When the parent calls "SendMessage" with "to" set to "reviewer" and a nonempty message.
    Then the response identifies the selected agent and acknowledges queued guidance.
    And the response does not claim that the tool was instantly interrupted or that the model followed the guidance.
    When the child reaches a supported guidance boundary.
    Then the guidance is made available to that child's conversation.

  @ACC-SA-03-02 @proposed
  Scenario: Resume a finished conversation under the same agent identity.
    Given a resumable agent has finished and has an intact saved conversation.
    And the parent is in a persistent TUI or RPC session.
    When the parent sends a new instruction to that agent with "SendMessage".
    Then a new background run is accepted for the same agent identifier.
    And the new run has a different run identifier.
    And the child continues its saved conversation rather than starting an unrelated conversation.

  @ACC-SA-03-03 @proposed @concurrency
  Scenario: Serialize simultaneous follow-up requests.
    Given a resumable agent is idle with an intact saved conversation.
    When two follow-up messages are submitted at the same time.
    Then only one new run is accepted for that agent.
    And both messages are associated with that run in acceptance order.
    And the saved session is not executed concurrently by two runners.

  @ACC-SA-03-04 @proposed
  Scenario Outline: Refuse resumption when its prerequisites are not met.
    Given the selected agent <condition>.
    When the parent requests resumption through "SendMessage".
    Then the response explains <reason>.
    And no replacement conversation or provider request is created.

    Examples:
      | condition                                  | reason                                  |
      | is a packaged one-shot Explore agent       | that this agent is not resumable        |
      | has a missing saved conversation           | that required history is unavailable    |
      | has a corrupted saved conversation         | that required history cannot be read    |
      | has an unavailable recorded model          | that the recorded model cannot be used  |
      | is still stopping its previous execution   | that termination has not been observed  |
      | has a missing recorded worktree            | that its working directory is missing   |
      | is reserved for worktree cleanup           | that cleanup prevents resumption        |

  @ACC-SA-03-05 @proposed @recovery
  Scenario: Retain guidance that was accepted but never submitted to the child.
    Given guidance was accepted for a child whose initialization has not completed.
    When initialization fails before the guidance is submitted to the SDK.
    Then the guidance is marked undelivered with the failure reason.
    And the user can inspect and copy the guidance.
    And a later explicit resume does not automatically resend it.

  @ACC-SA-03-06 @proposed @recovery
  Scenario: Report uncertain consumption honestly.
    Given the SDK accepted a guidance message.
    And no correlated event establishes that the child consumed it.
    When the run is cancelled or interrupted.
    Then the guidance is marked uncertain rather than consumed.
    And the host does not automatically replay that guidance as a new instruction.

  @ACC-SA-03-07 @proposed @concurrency
  Scenario: Handle guidance arriving as execution finishes.
    Given a resumable agent is approaching completion.
    When a new message races with the terminal outcome.
    Then the message is either accepted by the current run or assigned to a new eligible run.
    And the acknowledgment identifies the selected execution.
    And the message is not lost or executed in two concurrent runs.

  @ACC-SA-03-08 @proposed
  Scenario: Preserve a rejected message draft in the inspector.
    Given the user has composed guidance in the inspector.
    When submission is rejected because the selected agent cannot resume.
    Then the inspector explains the rejection.
    And the draft remains available for copying or revision.
    And no accepted-message acknowledgment is shown.
