# Subagent Support: Requirements

**Document type:** Software requirements specification.

**Status:** Maintained requirements for the subagent subsystem. These stories state required outcomes; they do not certify release readiness. Executed checks and remaining limits are recorded in the [verification report](../testing/subagent-verification.md). Revised 2026-09-19: SA-02 and SA-10 now require a single unified fleet indicator and a split fleet view overlay in place of the former FleetView and async widget, and SA-12 adds nested delegation; both revisions are implemented.

**Related documents:** [Research](../research/subagent-system-comparison.md), [interaction design](../ux/subagents.md), and [technical design](../arch/subagents.md).

**Composition revision:** Goal management and subagents are independent subsystems. The revised SA-08 and dependency boundary are implemented in the working tree, with executed checks and deployment limits in the [verification report](../testing/subagent-verification.md#2026-09-20-goal-independent-subagents-and-external-composition).

## 1. Purpose and Confirmed Constraints

Secretary will let a parent agent delegate work to child agents while the user can observe and control that work.

The following constraints were confirmed during design discussion:

- Claude Code provides the reference for tool names and input schemas.
- nicobailon/pi-subagents provides the reference for the TUI. Its inline display, fleet navigation, and inspector surfaces are ported onto Secretary's runtime. The ported FleetView summary and async widget are superseded by a single unified fleet indicator; the inspector becomes a split fleet view overlay. Surfaces that depend on out-of-scope runtime features are excluded explicitly in the [interaction design](../ux/subagents.md#8-ported-surface-exclusions).
- tintinweb/pi-subagents provides an implementation reference for pi integration.
- The subagent module must not know the goal system. Secretary composes these independent capabilities outside the subagent module.
- Child execution stops when pi exits. Saved conversations may be resumed explicitly later.
- Model selection uses named model fallback lists maintained in Secretary configuration. A definition or invocation model value first matches an exact model available in the session, then names a fallback list whose models are tried in configured order, and `inherit` selects the parent's model. The tool input exposes only configured list names.
- The initial scope includes core delegation, custom agent definitions, worktree isolation, output retrieval, and agent inspection.
- Conversation forks, agent teams, remote execution, scheduling, and workflow orchestration are deferred. Nested delegation is in scope under SA-12.

Behavioral details are specified in the linked architecture. A requirement's presence in this document is not evidence that every host integration has been verified; the verification report distinguishes executed checks from remaining gaps.

## 2. User Stories and Acceptance Criteria

### SA-01: Delegate a bounded task

As a parent agent, I want to delegate a task without changing my own conversation, model, or tools.

- The launch operation reports the selected agent type and resolved model.
- A background launch returns an identifier before execution completes.
- A foreground launch returns the outcome after execution completes.
- An unknown agent type or unavailable model produces an actionable error rather than a silent fallback.
- Fresh child sessions receive their task and applicable project instructions, but not the parent's conversation history.
- Launching a child does not create a goal implicitly.

### SA-02: Observe concurrent work

As a user, I want to see which agents are queued, starting, running, stopping, or finished while continuing to use the main editor.

- The fleet indicator shows current-session work without requiring repeated model tool calls, and it presents one list while agents are active: the main session row followed by non-terminal top-level agents. When no agent is active, the indicator is hidden. Activating the main session row returns focus to my prompt input.
- I can open an agent's task, transcript, result, and worktree information.
- Context-window usage and cumulative usage are labeled as different quantities and are never presented as goal-budget usage.
- A historical launch result does not falsely report that background execution has completed.
- Failures, partial results, and cancellation remain distinguishable from successful completion.
- The fleet view overlay remains open if the selected agent finishes.
- A display-surface fault never ends my session. If the agents UI configuration cannot be applied, the surfaces keep rendering with their documented defaults, I am told that the configuration was not applied, and the configured presentation returns when the configuration is readable again.

### SA-03: Guide and resume an agent

As a user or parent agent, I want to send guidance to an existing agent rather than creating a different conversation accidentally.

- The same recipient identifier addresses an agent while it runs and after it finishes.
- Acknowledgment states whether guidance was queued or a new execution was accepted.
- Acknowledgment does not claim that the model has followed the guidance.
- A finished resumable agent continues its saved conversation in the background.
- Two simultaneous follow-up requests cannot execute the same session concurrently.
- Missing history, changed permissions, or unavailable worktrees cause explicit recovery guidance rather than a fresh-session fallback.

### SA-04: Stop work without losing evidence

As a user or parent agent, I want to stop selected work without aborting unrelated agents or the main conversation.

- A stop request identifies its target and reports when cancellation is still pending.
- The active fleet indicator displays shortcuts for stopping the selected agent and stopping the current fleet. Users do not need to discover a command or open the inspector to find cancellation.
- Stopping all captures the current fleet's active executions for confirmation. It does not stop unrelated sessions, later launches, or replacement runs. The main editor retains its draft.
- Cancellation preserves available output and changes to files.
- Closing the inspector does not cancel work.
- Stopping an already finished run does not stop a later run by accident.
- No automatic restart follows user cancellation.

### SA-05: Retain and recover conversations

As a user, I want to inspect past work and explicitly resume supported agents after restarting pi.

- Exiting, reloading, or switching the parent session stops that parent's active child executions.
- Restoring a parent session restores its agent records without automatically restarting children.
- An interrupted process is not reported as a successful execution.
- Another session cannot obtain control of an agent merely by knowing its name.
- Deleted or corrupted session files produce a clear error.
- Rewinding before an agent launch excludes that work from the current conversation and fleet. Repeating the request can launch fresh agents with the same names without reusing previous outcomes.
- Rewinding requests cancellation of unfinished work admitted outside the selected conversation's ancestry. Work admitted on a shared ancestor remains available.
- Navigation does not undo completed work, token usage, output files, or filesystem changes. Returning to the original branch shows its retained execution history without replaying launches.
- An agent whose saved conversation advanced on an abandoned branch cannot resume as though that conversation had been rewound. Its retained earlier result remains inspectable.

### SA-06: Isolate repository changes

As a user, I want an agent to work in its own Git worktree without overwriting my checkout.

- Worktree launches report the branch, path, and base commit used.
- Uncommitted parent changes are not silently copied, stashed, or committed.
- Agent changes are not automatically merged or committed by the host.
- A worktree containing changes or agent commits is retained.
- Cleanup does not delete unrelated worktrees or discard modifications without confirmation.
- Worktree isolation is not described as a security sandbox.

### SA-07: Use custom agents and pi models

As a user, I want reusable agent definitions with predictable tool and model selection.

- Trusted project definitions can override user definitions and packaged definitions.
- The selected definition's source is visible in inspection.
- Model references resolve through configured model fallback lists; a missing or empty list fails the launch with an actionable error instead of selecting a different model silently.
- Omitting a model override supports inheritance from the parent when the definition supplies no model.
- Agent definitions cannot bypass the parent's tool or permission restrictions.

### SA-08: Compose delegation with goals

As a user, I want goal management and delegation to remain independent capabilities so that a stopped goal cannot prevent me from getting help, including work beyond its objective to resolve a blocker.

- Delegation works without enabling or initializing goal management.
- A blocked goal does not prevent a new user request from launching an agent, guiding a running agent, or assigning work to a finished resumable agent.
- Recovery requires neither a goal resume command nor a decision about whether the requested task belongs to the goal.
- User-directed work does not implicitly resume the goal or restart automatic continuation. Ordinary permissions, cancellation, session ownership, and branch rules remain in effect.
- The subagent module does not read goal state, own goal attribution, or enforce goal-specific execution policies.
- When the capabilities are composed, delegated usage can be included through the existing goal-budget formula without turning accounting association into permission to execute.
- Duplicate callbacks and restoration do not charge the same usage twice. Late usage is not reassigned to whichever goal exists when the result arrives.
- Finishing a child does not complete or resume a goal automatically, and old results cannot override newer goal decisions.
- Background children do not cause repeated automatic delegation while the parent is waiting for their results.

The [composition contract](../arch/goal-agent-composition.md) owns the interaction between the independent subsystems. Its deterministic standalone, composition, migration, and acceptance checks have passed; this does not claim deployment into an already running session.

### SA-09: Use tools without a terminal

As a client using print, JSON, or RPC mode, I want explicit execution and error behavior without a hidden interactive dependency.

- Tool execution does not require FleetView or an inspector.
- Operations requiring interactive confirmation fail clearly when confirmation is unavailable.
- Background work does not silently disappear at normal headless completion; the supported headless waiting policy is tested and documented.

### SA-10: Recognize delegated work through the ported presentation

As a user, I want Secretary's agent surfaces to present live and historical work with the same structure, controls, and labels as the nicobailon reference where the underlying runtime supports it.

- Inline results follow Pi's compact/full state, with no separate Secretary display-mode selector. `Agent` identifies the destination by type, instance name, and model; `SendMessage` identifies the recipient by type and instance name and previews the actual sent message, as shown in the revised UX wireframes.
- Full results reveal the details shown in those wireframes. Each potentially unbounded prompt, sent-message, or output field shows up to 200 wrapped display lines, with an omission notice and a path to its complete saved text; bounded metadata remains complete.
- The fleet indicator and the fleet view overlay present the same underlying state as tool responses, with themed rows, elapsed time, and labeled usage.
- The fleet view overlay presents a structured Markdown and tool transcript with scrollable detail, tool-detail expansion, and a footer that reflects the configured keys.
- Display configuration is validated; unsupported values fail rather than being ignored.
- Features excluded in the interaction design's ported-surface exclusions do not appear as disabled or placeholder controls.

### SA-11: Manage model fallback lists

As a user, I want to manage named model fallback lists from the TUI so that subagent model preferences survive subscription exhaustion without hand-editing configuration files.

- I reach the fallback lists through the Subagents section of the configuration menu, which groups subagent configuration items into a navigation list.
- I can create, rename, and remove named model fallback lists. The plugin ships with no lists; every list is one I created. Renaming keeps the list's models; agent definitions that reference the old name fail at launch until they are updated.
- I can add models to a list, remove models from a list, and change their order.
- When a subagent is launched through a list, its models are tried from first to last. If every model is unavailable, the launch fails with an actionable error that names what was tried.
- Changes made in the menu are persisted immediately and apply to subsequent launches. Under the SA-13 consistency policy, a launch requested by an already issued model response keeps the configuration advertised to that response; new requests receive the edited configuration.
- In print, JSON, and other non-interactive modes, the configuration command returns text guidance instead of opening a terminal component.

### SA-12: Delegate nested work

As a parent agent, I want a delegated agent to decompose its task further so that complex work does not have to be orchestrated from the top level.

- A running agent can launch its own child agents through the same delegation contract, within the tool and permission restrictions it inherited.
- A nested agent is recorded with its parent agent, and the fleet view overlay presents each agent's children as a drill-down level. The fleet indicator lists top-level agents only.
- Nested usage retains its originating run identity for external accounting consumers. When composed with goals, the SA-08 accounting and completion rules apply outside the subagent module.
- Stopping an agent stops its nested children; exiting the session stops the whole tree.
- Nesting is bounded by a documented maximum depth, and a launch beyond that depth fails with an actionable error.
- The fleet indicator and the fleet view overlay present the agent hierarchy correctly in sessions where no agent has children.

### SA-13: Discover agent definitions without filesystem probing

As a user, I want the parent agent to know the available delegation types automatically so that predefined and custom agents work without asking the model to locate or read their definition files.

**Status:** Implemented with deterministic SDK and acceptance coverage. Live-provider selection and cache behavior remain separate verification items in the [verification report](../testing/subagent-verification.md#2026-09-20-request-context-composition-and-agent-discovery).

- Before the first delegation decision, the parent can identify the available packaged, user-defined, and trusted project-defined agents by exact name and description, including `general-purpose`, `Explore`, and `Plan` when enabled.
- A model-issued filesystem read or a prior child launch is not required to discover the available types. A new agent instance's name is not confused with its definition type.
- The parent sees selection metadata rather than complete child instructions or private configuration. The runtime applies the selected definition without requiring the parent to reconstruct its prompt.
- Application-tracked state provides the reminder; the model does not invent or summarize the inventory. Repeated updates do not accumulate reminder copies in the saved conversation or change what the human originally wrote.
- Under the request-boundary update policy, file and configuration changes become available at the next model request. Work requested by an already issued response retains the definition that was advertised to that response, subject to current permissions and trust.
- Invalid or unavailable configuration produces an actionable failure rather than silently using a stale or partial inventory. Correcting the source allows a later request to recover.
- Discovery works in interactive and non-interactive sessions and in children that are permitted to delegate. A disabled delegation capability is not advertised as usable.
- Other deterministic state can later be added without changing the meaning of agent discovery. This extension point does not promise improved prompt-cache reuse or grant authority to resume a goal.

The [subagent discovery contract](../arch/subagents.md#54-request-scoped-definition-catalog) owns catalog contents, discovery lifecycle, launch consistency, and domain verification. It uses the independent [request-context mechanism](../arch/request-context.md) for composition.

## 3. Compatibility and Scope

- The compatibility baseline is Claude Code 2.1.272, as inspected in the research report.
- The tool names are `Agent`, `SendMessage`, `TaskStop`, and `TaskOutput`.
- `TaskOutput` is retained even though current Claude documentation deprecates it; this is a deliberate compatibility deviation.
- Existing pi built-in tools keep their names. This feature does not rename `read` to `Read` or emulate the entire Claude Code environment.
- The design promises a documented subset of Claude Code behavior, not complete Claude Code compatibility.
- External terminal panes, invisible model calls for mentions, agent-definition editing wizards, and workflow engines are outside this release.

## 4. Acceptance and Verification

- Implemented requirements are validated through the scenarios linked from the technical design and executed by the acceptance suite. SA-13 has dedicated real-SDK request-boundary tests and acceptance bindings; generic serializer tests alone are not evidence of agent discovery.
- Passing tests do not establish visual conformance; TUI interaction review and human approval are separate.
- The [verification report](../testing/subagent-verification.md) records which checks have run and which remain open.
