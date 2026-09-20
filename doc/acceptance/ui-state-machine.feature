@subagents @draft @ui @SA-02
Feature: Keep interaction state consistent during asynchronous agent activity
  As a user,
  I want navigation, dialogs, and execution to have distinct state transitions,
  so that delayed responses do not redirect my actions or discard my work.

  @ACC-SA-UI-01 @proposed
  Scenario: Escape closes only the focused dialog.
    Given a running agent's fleet view overlay is open.
    And the user is composing an unsent message.
    When the user presses Escape once.
    Then the composer closes without sending the message.
    And the fleet view overlay remains open and focused.
    And the agent is not cancelled.
    When the user presses Escape again.
    Then the main editor and its draft regain focus.
    And the agent continues running.

  @ACC-SA-UI-02 @proposed @concurrency
  Scenario: Ignore a stale transcript response after selecting another agent.
    Given transcript loading for agent A is pending.
    When the user selects agent B before A finishes loading.
    And B's transcript is displayed.
    And A's earlier response arrives afterward.
    Then B remains selected and visible.
    And A's response does not replace the displayed transcript or move focus.

  @ACC-SA-UI-03 @proposed @SA-03 @concurrency
  Scenario: Emit only one message request during repeated submission input.
    Given the composer contains valid guidance for the selected agent.
    When the user submits the guidance twice before the first acknowledgment arrives.
    Then one guidance operation is submitted.
    And the dialog indicates that submission is pending.
    And no second message or resumed run is created by the repeated input.

  @ACC-SA-UI-04 @proposed @SA-03
  Scenario: Preserve the draft when message submission is definitively rejected.
    Given the user submitted guidance from the composer.
    When the service rejects that submission before acceptance.
    Then the composer displays the original draft and an actionable error.
    And focus remains available for revising the draft.
    And no accepted-message confirmation is shown.

  @ACC-SA-UI-05 @proposed @SA-03 @recovery
  Scenario: Resolve uncertain acceptance without submitting the operation again.
    Given a submitted message has no definite acknowledgment or rejection.
    When the interface reports its acceptance as uncertain.
    Then the submitted text and target remain inspectable.
    And a new submission is disabled while that operation is unresolved.
    When the original operation receipt establishes acceptance.
    Then the interface reports that accepted operation.
    And it does not send a replacement message or start another run.

  @ACC-SA-UI-06 @proposed @concurrency
  Scenario: A dismissed submission cannot close a newer dialog.
    Given a message submission is still pending.
    When the user dismisses its dialog.
    And the user opens an unrelated eligible dialog.
    And the earlier submission acknowledgment arrives.
    Then the newer dialog retains its target, contents, and focus.
    And the earlier operation remains available in the owning agent's history.
    And dismissing the earlier dialog did not retract or retry its operation.

  @ACC-SA-UI-07 @proposed @SA-03
  Scenario: Keep a composer open when the selected agent completes.
    Given the user is composing guidance for a resumable running agent.
    When that agent completes.
    Then the composer retains its recipient and draft.
    And the available action explains that submission will resume the conversation.
    And completion does not submit the draft automatically.

  @ACC-SA-UI-08 @proposed @SA-04 @concurrency
  Scenario: Reject a stop confirmation whose execution is no longer eligible.
    Given the user is confirming a stop for run A.
    When run A completes and run B starts for the same agent.
    Then the confirmation closes with an explanation that its target changed or finished.
    And no stop request is submitted for run B.

  @ACC-SA-UI-09 @proposed @SA-04
  Scenario: Do not invalidate a stop confirmation for ordinary progress.
    Given the user is confirming a stop for a running execution.
    When that same execution emits more transcript output but remains eligible to stop.
    Then the confirmation retains its original execution target.
    And ordinary progress does not dismiss the confirmation or redirect it.

  @ACC-SA-UI-10 @proposed @SA-05 @recovery
  Scenario: Prevent an old response from reopening UI after session replacement.
    Given the current parent has a pending transcript load or dialog submission.
    When the user switches to another parent session.
    And the earlier operation responds afterward.
    Then no view or dialog from the previous activation reopens.
    And the new session's focus and editor text remain unchanged.
    And any durable operation outcome remains attributed to the original parent.

  @ACC-SA-UI-11 @proposed
  Scenario: Keep transcript following paused through resize and completion.
    Given the user has scrolled away from the end of an agent transcript.
    When the terminal is resized and the selected agent completes.
    Then the reading position remains anchored to the retained content where available.
    And the view does not resume following automatically.
    When the user returns to the end of the transcript.
    Then following is enabled again.

  @ACC-SA-UI-12 @proposed @SA-06
  Scenario: Return direct command confirmation to its originating editor.
    Given the main editor is focused and contains an unsent draft.
    When the user opens cleanup confirmation through an explicit command.
    And the user dismisses confirmation without accepting it.
    Then focus returns to that editor with the draft preserved.
    And no fleet view overlay is opened merely to complete the command.
    And no worktree cleanup request is submitted.

  @ACC-SA-UI-13 @proposed
  Scenario: Keep a missing transcript associated with the requested agent.
    Given the user selected agent A for inspection.
    When A's transcript fails to load.
    Then the fleet view overlay identifies A and explains why its transcript is unavailable.
    And the interface does not silently select another agent.
    And the user can retry loading A, select another agent, or close the fleet view overlay.

  @ACC-SA-UI-14 @proposed @SA-10
  Scenario: List active background work in the fleet indicator.
    Given two background agents are running and one has completed.
    When the fleet indicator renders below the editor.
    Then its first row is the main session.
    And it lists the running executions with a status label, elapsed time, and usage labels.
    And the completed execution is absent from the indicator.
    And the fleet indicator and tool responses show the same underlying state.

  @ACC-SA-UI-15 @proposed @SA-10
  Scenario: Use host compact and full state rather than a Secretary inline display mode.
    Given legacy agents.ui.inlineToolDisplay values "rich" and "summary" are accepted and ignored.
    When an Agent call completes in compact state.
    Then its result body shows the outcome without the original prompt or child result.
    When the host expands that call.
    Then its result body exposes the original prompt and child result.
    When a foreground call is running in compact state.
    Then its body shows progress and an expansion hint without a task preview.

  @ACC-SA-UI-16 @proposed @SA-10
  Scenario: Reflect configured overlay keybindings in behavior and hints.
    Given agents.ui.fleetKeybindings overrides the stop and close actions.
    When the user presses the configured stop key in the fleet view overlay.
    Then stop confirmation opens for the selected run.
    And the footer displays the configured keys, not the defaults.
    When the configuration contains an unsupported key or value.
    Then configuration validation fails with an explicit error.

  @ACC-SA-UI-17 @proposed @SA-10
  Scenario: Present the bordered fleet view overlay layout with width fallbacks.
    Given the fleet view overlay is open with an agent selected.
    Then the overlay shows a bordered frame, a title row, a selection-position indicator, and a footer.
    When the terminal is narrower than the two-pane threshold.
    Then the roster stacks above a full-width detail view.
    When the terminal is below the minimum supported width.
    Then only a diagnostic line is shown.

  @ACC-SA-UI-18 @proposed @SA-04
  Scenario: Stop the selected agent from the focused fleet list.
    Given the bottom fleet list contains active agents.
    Then one hint line above the main row explains that Down in an empty editor focuses the list.
    When the user focuses the fleet list.
    Then the same hint line shows X for stopping the selected agent and Ctrl+X for stopping all agents.
    When the user returns focus to the editor.
    Then the hint switches back without changing the list height.
    When the user types X in the main editor.
    Then the editor retains the input and no cancellation is requested.
    When the user focuses an agent in the list and presses X.
    Then confirmation identifies that agent's exact execution.
    When the user dismisses confirmation.
    Then no cancellation is requested and the list regains focus.

  @ACC-SA-UI-19 @proposed @SA-04 @concurrency
  Scenario: Stop only the fleet executions captured before confirmation.
    Given this parent has active agents and the main editor contains a draft.
    When the user presses Ctrl+X.
    Then confirmation captures this parent's active top-level executions.
    When one captured execution is replaced and a new agent is admitted.
    And the user confirms cancellation.
    Then cancellation targets only the captured executions that remain eligible.
    And the replacement, new agent, and unrelated sessions are not targeted.
    And the editor draft remains unchanged.
    And acceptance is not presented as completed cancellation.

  @ACC-SA-UI-20 @proposed @SA-04 @concurrency
  Scenario: Keep uncertain fleet cancellation from being submitted twice.
    Given fleet cancellation was submitted from the overlay and its acknowledgment was lost.
    When the user dismisses the pending dialog and presses X or Ctrl+X again.
    Then the unresolved operation is shown instead of a replacement request.
    When the original receipt confirms acceptance.
    Then the uncertainty clears without resubmitting cancellation.
