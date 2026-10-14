@vm-use @draft
Feature: Delegate a desktop task to the vm-use agent
  As a parent agent,
  I want to hand a desktop task to the vm-use agent and receive facts about what it did,
  so that the task runs in a disposable machine and my conversation stays free of per-step details.

  # These scenarios run live: Pi loads the extension, the real planner and grounder decide, and the
  # task runs in a relay machine. ACC-VU-25 needs only Pi loading the extension.

  @ACC-VU-01 @confirmed @VU-01 @VU-02 @VU-05 @VU-06
  Scenario: A delegated task completes with a compact report of the window after the plan.
    Given Calculator is open with a cleared display in a relay machine.
    When the parent delegates "compute 7 + 3 in Calculator" to the vm-use agent.
    Then the run is reported as succeeded.
    And the last plan completed, and each of its steps acted once.
    And the display shows "10" when the task's check reads it.
    And the report the parent receives states the result "10".
    And the parent's conversation contains no observation or UI element table of any step.
    And every step of the last plan names the relay steps that hold its screenshots.

  @ACC-VU-02 @confirmed @VU-05
  Scenario: A result already on screen is not reported as the agent's work.
    Given Calculator is open and already shows "10" in a relay machine.
    When the parent delegates "make Calculator show 10" to the vm-use agent.
    Then no plan sends an action.
    And the report the parent receives says that the result was already on screen.

  @ACC-VU-03 @confirmed @VU-03
  Scenario: A UI element that does not exist stops the task with a named reason.
    Given Calculator is open in a relay machine.
    When the parent delegates "press the Launch Rocket button in Calculator" to the vm-use agent.
    Then no plan completes.
    And no step sends an action.
    And the report the parent receives says that the button was not found.

  @ACC-VU-20 @proposed @VU-04 @PS-D53
  Scenario: In the mode none, a plan runs with no permission check and nobody is asked.
    Given Reminders is open in a relay machine.
    And the permission check mode is "none", the default, in configuration.
    When the parent delegates "add a reminder called Buy milk" to the vm-use agent.
    Then no request was sent to the online API.
    And no plan's run has a permission record.
    And no person was asked for approval.
    And Reminders shows a reminder called "Buy milk" when the task's check reads it.

  @ACC-VU-21 @proposed @VU-04 @PS-D53
  Scenario: In the mode online, a plan with no step that needs approval runs without a dialog.
    Given Calculator is open with a cleared display in a relay machine.
    And the permission check mode is "online" with an online API in configuration.
    When the parent delegates "compute 7 + 3 in Calculator" to the vm-use agent.
    Then each plan's permission record holds the online API's answers for every step of the plan, and no step needs approval.
    And no person was asked for approval.
    And the display shows "10" when the task's check reads it.

  @ACC-VU-22 @proposed @VU-04 @PS-D53
  Scenario: A plan with a step that leaves the guest asks once before its first step, and an approved plan runs every step without stopping.
    Given Safari shows a page "Contact Support" with a message field and a "Send" button that sends the message to the shop's support team, in a relay machine.
    And the permission check mode is "online" with an online API in configuration.
    And a person at the main session's interface approves when asked.
    When the parent delegates "send the message 'My order has not arrived' to the support team".
    Then the person was asked once for the plan that presses "Send", before that plan's first read of the window.
    And the dialog listed the step that presses "Send", with the reason that its effect leaves the guest.
    And after the approval, every step of that plan acted once, and nobody was asked again during the plan.
    And the page shows that the message was sent when the task's check reads it.

  @ACC-VU-23 @proposed @VU-04 @PS-D53
  Scenario: A declined plan sends nothing.
    Given Safari shows a page "Contact Support" with a message field and a "Send" button that sends the message to the shop's support team, in a relay machine.
    And the permission check mode is "online" with an online API in configuration.
    And a person at the main session's interface declines when asked.
    When the parent delegates "send the message 'My order has not arrived' to the support team".
    Then the plan that presses "Send" ended with the reason "approval_denied", naming that step.
    And that plan ended before its first read of the window, and none of its steps sent an action.
    And the report the parent receives says that the person declined.
    And the page shows that no message was sent when the task's check reads it.

  @ACC-VU-04 @proposed @VU-04 @PS-D53
  Scenario Outline: A plan with a step that leaves the guest sends nothing when nobody can approve it.
    Given Safari shows a page "Contact Support" with a message field and a "Send" button that sends the message to the shop's support team, in a relay machine.
    And the preparation confirmed that the page is open before the task starts.
    And the permission check mode is "online" with an online API in configuration.
    And <who can answer>.
    When the parent delegates "send the message 'My order has not arrived' to the support team".
    Then the plan that presses "Send" ended with the reason "approval_required" before its first read of the window.
    And no step of that plan sent an action.
    And that plan's permission record marks the step that presses "Send" with the reach "outside_guest" and the approval answer <answer>.
    And the page shows that no message was sent when the task's check reads it.

    Examples:
      | who can answer                                                                                        | answer         |
      | the run has no interface through which a person could approve                                         | "no_interface" |
      | a person is at the main session's interface but does not answer before the approval time limit ends   | "timeout"      |

  @ACC-VU-09 @proposed @VU-04 @PS-D16 @PS-D53
  Scenario: The task can ask for approval of a step that would otherwise run.
    Given Safari shows a shop page with an "Add to Cart" button in a relay machine.
    And the permission check mode is "online" with an online API in configuration.
    And the run has no interface through which a person could approve.
    When the parent delegates "add the mouse to the cart, but ask me before adding anything to the cart".
    Then the plan that presses "Add to Cart" ended with the reason "approval_required" before its first read of the window.
    And that plan's permission record marks the step that presses "Add to Cart" with the answer "yes" to whether the request asks for approval.

  @ACC-VU-24 @proposed @VU-04 @PS-D53
  Scenario: A failed online check makes every step of the plan need approval.
    Given Calculator is open with a cleared display in a relay machine.
    And the permission check mode is "online", and the configured online API cannot be reached.
    And the run has no interface through which a person could approve.
    When the parent delegates "compute 7 + 3 in Calculator" to the vm-use agent.
    Then every plan ended with the reason "approval_required" before its first read of the window.
    And each plan's permission record marks every step as needing approval because the check failed.
    And no step sent an action.

  @ACC-VU-25 @proposed @VU-04 @PS-D53
  Scenario: The mode online without an online API fails to load.
    Given the configuration sets the permission check mode "online" and does not set "vmUse.permissionOnline".
    When Pi loads the extension.
    Then vm-use is disabled with an error that names "vmUse.permissionOnline".
    And the tools "vm_observe" and "vm_run_plan" are not registered.

  @ACC-VU-26 @proposed @VU-04 @PS-D54
  Scenario: The delegated request turns the check off over a configured mode online.
    Given Safari shows a page "Contact Support" with a message field and a "Send" button that sends the message to the shop's support team, in a relay machine.
    And the permission check mode is "online" with an online API in configuration.
    And the run has no interface through which a person could approve.
    When the parent delegates "send the message 'My order has not arrived' to the support team, without permission checks".
    Then every plan's record states the permission check mode "none" from the request.
    And no request was sent to the online API, and no person was asked for approval.
    And the page shows that the message was sent when the task's check reads it.

  @ACC-VU-27 @proposed @VU-04 @PS-D54
  Scenario: The delegated request asks for the check over the configured mode none.
    Given Safari shows a page "Contact Support" with a message field and a "Send" button that sends the message to the shop's support team, in a relay machine.
    And the permission check mode is "none", the default, and an online API is configured.
    And the run has no interface through which a person could approve.
    When the parent delegates "send the message 'My order has not arrived' to the support team, and check with me before anything is sent".
    Then the plan that presses "Send" states the permission check mode "online" from the request.
    And that plan ended with the reason "approval_required" before its first read of the window.
    And the page shows that no message was sent when the task's check reads it.

  @ACC-VU-28 @proposed @VU-04 @PS-D54
  Scenario Outline: A request that does not mention permission checks uses the configured mode.
    Given Calculator is open with a cleared display in a relay machine.
    And the permission check mode is <mode> with an online API in configuration.
    When the parent delegates "compute 7 + 3 in Calculator" to the vm-use agent.
    Then every plan's record states the permission check mode <mode> from the configuration.
    And the display shows "10" when the task's check reads it.

    Examples:
      | mode     |
      | "none"   |
      | "online" |

  @ACC-VU-05 @confirmed @VU-07
  Scenario: A task whose application is not open stops, and the agent launches nothing.
    Given no application is opened in the relay machine.
    When the parent delegates "compute 7 + 3 in Calculator" to the vm-use agent.
    Then Calculator is not running when the task's check reads it.
    And the report the parent receives says that Calculator is not open.

  @ACC-VU-06 @confirmed @VU-03
  Scenario: An unavailable decision service stops the task, and the planner does not act.
    Given Calculator is open in a relay machine.
    And the decision service cannot be reached.
    When the parent delegates "compute 7 + 3 in Calculator" to the vm-use agent.
    Then every plan that ran escalated with the reason "grounder_unavailable".
    And no step sent an action.

  @ACC-VU-07 @confirmed @PS-D11
  Scenario: The main agent has no computer tools, and the machine is released before the run ends.
    Given any scenario of this feature ran.
    When its runs have ended.
    Then the parent never called "vm_observe" or "vm_run_plan".
    And every relay lease of the run has a lifecycle record that says it was released.
    And each lease was released before the run that used it was recorded as ended.

  @ACC-VU-08 @confirmed @PS-D11 @SA-04
  Scenario: A cancelled run releases its machine before it is reported cancelled.
    Given the vm-use agent is running a task in a relay machine.
    When the parent stops it with "TaskStop".
    Then the run is reported as cancelled.
    And its relay lease has a lifecycle record that says it was released.
    And the lease was released before the run was recorded as ended.

  @ACC-VU-10 @proposed @VU-08 @PS-D17 @PS-D18 @PS-D40
  Scenario: The trajectory follows the agent's session and shows each plan step under its tool call.
    Given the parent delegated a task, and later sent the vm-use agent a message that resumed it on a second machine.
    When a maintainer opens the agent's trajectory in the viewer after both machines are finished.
    Then its first item is the prompt that spawned the agent, and the message where the second run began is an item of its own.
    And every message and tool call of the agent is an item, in the order the session recorded it.
    And each "vm_run_plan" call is followed by its plan's steps in plan order, each plan step by the machine steps it ran, and then by the result the agent received.
    And each machine step names the plan step or the tool call that asked for it.
    And the checks after a run are not items, and the Overview counts them for their machine.
    And the Overview names both machines, with each machine's verdicts.

  @ACC-VU-19 @proposed @VU-08 @PS-D40 @PS-D43 @PS-D44 @PS-D53
  Scenario: The trajectory shows the plan check and how long the plan waited for a person's approval.
    Given the online plan check marked a step of a plan, and a person approved the plan after a wait.
    When a maintainer opens the agent's trajectory in the viewer.
    Then the plan's "vm_run_plan" call shows the online API's round trip, the step that needed approval with its reason, the answer "approved" and how long the approval waited.
    And the panel of each plan step of that plan shows the step's answers from the check.
    And the time the call took, shown in its caption in the track, includes that wait.
    And the plan's first plan step comes after the wait, and its interval pill measures from the call's start.

  @ACC-VU-13 @proposed @VU-08 @PS-D41 @PS-D42 @PS-D43 @PS-D44
  Scenario: The track tells host steps from guest steps and shows the time between steps.
    Given a vm-use agent's run with tool calls, plan steps and machine steps.
    When a maintainer opens the agent's trajectory in the viewer.
    Then each thumbnail in the track has a line above it with the step number in a step pill at the left, and the word Host or VM with an icon at the right.
    And the icon is a robot for the agent's items and the plan steps, and a virtual machine for the machine steps.
    And the caption under each thumbnail shows the step's status dot, its name and the time it took.
    And the monitor's heading shows the step pill, the step's name with the time it took, and the same word and icon.
    And a tool call's caption shows the time from the call to its result, and a machine step's caption the time from its action to its after snapshot.
    And before each step with a start time, a pill shows the time from the end of the latest earlier step that it does not lie inside, or from the start of a step it lies inside, whichever is later.
    And the pill before a plan step's first machine step measures from the plan step's start.
    And the pill's tooltip names the step and the edge it measures from.

  @ACC-VU-29 @proposed @VU-08 @PS-D60
  Scenario Outline: A machine step's snapshots show where it clicked and with which mouse button.
    Given a machine step that sent the command <command>.
    When a maintainer selects the step in the agent's trajectory.
    Then the before snapshot shows a solid <marker> centred on the point the click landed, and the after snapshot shows the same marker as an outline.
    And the panel's Pointer row names the <input> with its point in screen points and in snapshot pixels.
    And the key M hides the markers and shows them again.

    Examples:
      | command                                                      | marker                    | input             |
      | click {"scope":"desktop","x":1546,"y":910}                   | blue ring with "L"        | left click        |
      | click {"scope":"desktop","x":1546,"y":910,"button":"right"}  | orange ring with "R"      | right click       |
      | click {"scope":"desktop","x":1546,"y":910,"button":"middle"} | purple ring with "M"      | middle click      |
      | click {"scope":"desktop","x":1546,"y":910,"count":2}         | two blue rings with "L×2" | left double click |

  @ACC-VU-30 @proposed @VU-08 @PS-D60
  Scenario: An accessibility action is not shown as a click, and a missing position is not guessed.
    Given a machine step that showed a UI element's context menu through accessibility, and a machine step that clicked at a position that was not recorded.
    When a maintainer selects each step in the agent's trajectory.
    Then the first step's snapshots show a dashed box around the UI element labelled "AX show menu", and no right-click marker.
    And the second step's snapshots show no marker, and its Pointer row says "Position not recorded".

  @ACC-VU-11 @proposed @VU-09 @PS-D31 @PS-D32 @PS-D39
  Scenario Outline: The agent operates the computer the way the person asked.
    Given TextEdit is open with an empty document in a relay machine.
    When a person asks the main agent "<request>", and the main agent delegates it to the vm-use agent.
    Then the run is reported as succeeded, and the document's text is "Hello".
    And every grounder request of the run holds the delegated request as written.
    And the relay evidence labels every action of the run with the input mode <input mode>.

    Examples:
      | request                                                                                                    | input mode      |
      | Type Hello into the TextEdit document.                                                                     | "ordinary"      |
      | I use VoiceOver. Please type Hello into the TextEdit document.                                             | "ordinary"      |
      | As an accessibility test, set the TextEdit document's text to Hello through its accessibility functions.   | "accessibility" |
