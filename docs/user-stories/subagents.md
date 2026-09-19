# Subagent Support: Requirements

**Document type:** Software requirements specification.

**Status:** Maintained requirements for the implemented subagent subsystem. These stories state required outcomes; they do not certify release readiness. Executed checks and remaining limits are recorded in the [verification report](../testing/subagent-verification.md).

**Related documents:** [Research](../research/subagent-system-comparison.md), [interaction design](../ux/subagents.md), and [technical design](../arch/subagents.md).

## 1. Purpose and Confirmed Constraints

Secretary will let a parent agent delegate work to child agents while the user can observe and control that work.

The following constraints were confirmed during design discussion:

- Claude Code provides the reference for tool names and input schemas.
- nicobailon/pi-subagents provides the reference for the TUI. Its inline display, FleetView, async widget, and inspector surfaces are ported onto Secretary's runtime. Surfaces that depend on out-of-scope runtime features are excluded explicitly in the [interaction design](../ux/subagents.md#8-ported-surface-exclusions).
- tintinweb/pi-subagents provides an implementation reference for pi integration.
- Child execution stops when pi exits. Saved conversations may be resumed explicitly later.
- Model selection uses named model fallback lists maintained in Secretary configuration. A definition or invocation model value first matches an exact model available in the session, then names a fallback list whose models are tried in configured order, and `inherit` selects the parent's model. The tool input exposes only configured list names.
- The initial scope includes core delegation, custom agent definitions, worktree isolation, output retrieval, and agent inspection.
- Conversation forks, nested delegation, agent teams, remote execution, scheduling, and workflow orchestration are deferred.

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

- FleetView and the async widget show current-session work without requiring repeated model tool calls.
- I can open an agent's task, transcript, result, and worktree information.
- Context-window usage and cumulative usage are labeled as different quantities and are never presented as goal-budget usage.
- A historical launch result does not falsely report that background execution has completed.
- Failures, partial results, and cancellation remain distinguishable from successful completion.
- The inspector remains open if the selected agent finishes.

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

### SA-08: Account for delegated goal work

As a user with an active goal, I want delegated usage included without changing the meaning of my goal budget.

- Descendant usage uses the existing goal-budget formula.
- Usage is attributed to the goal that authorized the execution, not whichever goal happens to exist when a result arrives.
- Duplicate callbacks and restoration do not charge the same usage twice.
- Finishing a child does not complete or resume a goal automatically.
- Old child results cannot override a newer pause, objective change, clear, or replacement goal.
- Background children do not cause repeated automatic delegation while the parent is waiting for their results.

### SA-09: Use tools without a terminal

As a client using print, JSON, or RPC mode, I want explicit execution and error behavior without a hidden interactive dependency.

- Tool execution does not require FleetView or an inspector.
- Operations requiring interactive confirmation fail clearly when confirmation is unavailable.
- Background work does not silently disappear at normal headless completion; the supported headless waiting policy is tested and documented.

### SA-10: Recognize delegated work through the ported presentation

As a user, I want Secretary's agent surfaces to present live and historical work with the same structure, controls, and labels as the nicobailon reference where the underlying runtime supports it.

- Inline results offer a rich expandable display and a configurable summary display.
- FleetView and the async widget present the same underlying state as tool responses, with themed rows, elapsed time, and labeled usage.
- The inspector presents a structured Markdown and tool transcript with scrollable detail, tool-detail expansion, and a footer that reflects the configured keys.
- Display configuration is validated; unsupported values fail rather than being ignored.
- Features excluded in the interaction design's ported-surface exclusions do not appear as disabled or placeholder controls.

### SA-11: Manage model fallback lists

As a user, I want to manage named model fallback lists from the TUI so that subagent model preferences survive subscription exhaustion without hand-editing configuration files.

- I can create and remove named model fallback lists. The plugin ships with no lists; every list is one I created.
- I can add models to a list, remove models from a list, and change their order.
- When a subagent is launched through a list, its models are tried from first to last. If every model is unavailable, the launch fails with an actionable error that names what was tried.
- Changes made in the menu are persisted immediately and apply to subsequent launches.
- In print, JSON, and other non-interactive modes, the configuration command returns text guidance instead of opening a terminal component.

## 3. Compatibility and Scope

- The compatibility baseline is Claude Code 2.1.272, as inspected in the research report.
- The tool names are `Agent`, `SendMessage`, `TaskStop`, and `TaskOutput`.
- `TaskOutput` is retained even though current Claude documentation deprecates it; this is a deliberate compatibility deviation.
- Existing pi built-in tools keep their names. This feature does not rename `read` to `Read` or emulate the entire Claude Code environment.
- The design promises a documented subset of Claude Code behavior, not complete Claude Code compatibility.
- External terminal panes, invisible model calls for mentions, agent-definition editing wizards, and workflow engines are outside this release.

## 4. Acceptance and Verification

- Requirements are validated through the scenarios linked from the technical design and executed by the acceptance suite.
- Passing tests do not establish visual conformance; TUI interaction review and human approval are separate.
- The [verification report](../testing/subagent-verification.md) records which checks have run and which remain open.
