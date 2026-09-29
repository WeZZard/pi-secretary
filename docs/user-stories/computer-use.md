# Computer-Use Subagent: Requirements

**Document type:** Software requirements specification.

**Status:** Approved by the owner on 2026-09-24. CU-01 to CU-07 are approved as written. The stories restate the required outcomes of [technical design Section 2.1](../arch/computer-use.md#21-required-outcomes) and add outcomes learned from the live checks in [research Sections 11 and 12](../research/computer-use-s0-s1.md#11-first-checks-through-pi-2026-09-23).

**Related documents:** [Technical design](../arch/computer-use.md), [research](../research/computer-use-s0-s1.md), and the [subagent requirements](subagents.md), whose delegation stories this subsystem reuses.

## 1. Purpose and Confirmed Constraints

Secretary will let a parent agent delegate a task on a macOS desktop application to a computer-use agent. The computer-use agent plans the task, carries it out step by step, and reports what it achieved.

The following constraints were confirmed during design:

- Actions use real pointer and keyboard input by default. Direct accessibility activation is reserved for accessibility tests, as relay decision D3 requires.
- Desktop work runs in a disposable virtual machine through the relay. Operating the user's own desktop requires an explicit developer setting and is limited to disposable windows.
- The computer-use agent is a Secretary subagent. Launching, observing, stopping and resuming it follow the [subagent requirements](subagents.md).
- The per-step decision is made by the structured-decision executor service, not by the planning model.

## 2. User Stories and Acceptance Criteria

### CU-01: Delegate a desktop task

As a parent agent, I want to delegate a desktop task in natural language, so that my own conversation stays free of per-step screen details.

- The launch accepts a task description, the target application and, optionally, a window title.
- The parent receives one compact outcome report when the task ends.
- The parent's conversation does not receive the element tables, executor answers or screenshots of individual steps.

### CU-02: Know what happened

As a parent agent, I want the report to say what was done and what was checked, so that I pass on only facts.

- The report states whether the task completed, was stopped, or was cancelled.
- The report lists each step that ran, with its action, its target and its check result.
- The report separates facts that code checked after a step from steps that were only seen to change something.
- When the task stops early, the report states the step and the reason.

### CU-03: Stop instead of guessing

As a user, I want a wrong or uncertain action to stop the task with a stated reason, so that errors do not compound.

- An action whose check fails, or that changes nothing, is not repeated without limit. The task stops with a named reason after the configured attempts.
- An action that could have happened but whose outcome is unknown is never sent again.
- A step whose success cannot be shown, because its check already held before the step, stops the task unless the step is marked safe to repeat.
- An unavailable decision service stops the task. The planning model does not take over the steps.

### CU-04: Never act beyond the permission I set

As a user, I want the agent to send nothing to another person, service or account, and to destroy nothing on a machine that persists, unless I approved that action or chose to bypass approvals.

- In the default mode, an action that leaves the machine, or that destroys data on a machine that persists, stops before any input until a person approves it.
- In a relay machine, which is discarded after the task, destroying data inside the machine proceeds and is recorded.
- Neither the plan nor the agent that delegated the task can approve an action.
- The task can name further actions that need my approval, such as adding items to a cart.

### CU-05: Report results from this task's own actions

As a parent agent, I want a reported result to come from the actions of this task, so that an old screen is not reported as new work.

- When the screen already shows the requested result before the agent acts, the report says so and does not claim that the agent produced it.
- A result that the report calls checked was checked by code after an action of this task.

This story comes from a live check in which the planner answered from a display left over from an earlier run and called the answer verified ([research Section 12.2](../research/computer-use-s0-s1.md#122-pi-tasks-with-the-fixes-in-place)).

### CU-06: Leave evidence a person can review

As a maintainer, I want every step to leave evidence, so that I can find why a task failed and approve a result.

- Each step's record lets a maintainer decide whether a failure came from finding the element or from choosing it.
- When step pictures are enabled, each action has a picture of the target window before and after it, and a review page lists them with their checks.
- Records and pictures that may show window contents or typed text stay in local, ignored storage, and typed text can be redacted.
- Recorded evidence is labelled as evidence. It is never presented as a person's approval.

### CU-07: Keep the user's desktop out of reach by default

As a user, I want the agent to work in a disposable virtual machine unless I choose otherwise, so that it cannot disturb my own work.

- Without the developer setting, the agent cannot operate this machine's desktop.
- The agent does not launch applications. A task whose target application is not open stops with a named reason.

## 3. Out of Scope

- Tasks that span several applications in one plan.
- Web automation inside a browser page through a browser protocol. The agent sees a browser only through its accessibility tree.
- Degraded operation in which the planning model performs steps when the decision service is unavailable.
- Direct accessibility activation, unless the owner revises decision D3.

## 4. Decisions

| Decision | Outcome |
| --- | --- |
| Approve CU-01 to CU-07. | Approved as written on 2026-09-24. |
| Should CU-05 require the agent to act again when the result is already on screen, or only to say that it did not act? | Settled by CU-05 as approved: the report says that the result was already on screen, and the agent does not claim it. |
| Does the parent's view of a running computer-use agent need its own interaction design? | Open. The recommendation is yes: the fleet view should show the current step and the last check, which the subagent interaction design does not cover. |
