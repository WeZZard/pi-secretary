# vm-use Subagent: Requirements

**Document type:** Software requirements specification.

**Status:** Approved by the owner on 2026-09-24. VU-01 to VU-07 are approved as written, except VU-04, whose text follows decision PS-D53 and awaits the owner's approval. The stories restate the required outcomes of [technical design Section 2.1](../arch/vm-use.md#21-required-outcomes) and add outcomes learned from the live checks in [research Sections 11 and 12](../research/vm-use-s0-s1.md#11-first-checks-through-pi-2026-09-23).

**Related documents:** [Technical design](../arch/vm-use.md), [research](../research/vm-use-s0-s1.md), and the [subagent requirements](subagents.md), whose delegation stories this subsystem reuses.

## 1. Purpose and Confirmed Constraints

Secretary will let a parent agent delegate a task on a macOS desktop application to a vm-use agent. The vm-use agent plans the task, carries it out step by step, and reports what it achieved.

The following constraints were confirmed during design:

- Actions use real pointer and keyboard input, as a person's would, unless the delegated task asks for an accessibility test or for content reached through the operating system's accessibility functions. Such actions are carried out with those functions (decisions PS-D31 and PS-D39).
- Desktop work runs only in a disposable virtual machine, the guest, through the relay. No setting lets the agent operate the user's own desktop (decision PS-D49).
- The vm-use agent is a Secretary subagent. Launching, observing, stopping and resuming it follow the [subagent requirements](subagents.md).
- The per-step decision is made by the grounder, a structured-decision service, not by the planning model.

## 2. User Stories and Acceptance Criteria

### VU-01: Delegate a desktop task

As a parent agent, I want to delegate a desktop task in natural language, so that my own conversation stays free of per-step screen details.

- The launch accepts a task description, the target application and, optionally, a window title.
- The parent receives one compact outcome report when the task ends.
- The parent's conversation does not receive the UI element tables, grounder answers or screenshots of individual steps.

### VU-02: Know what happened

As a parent agent, I want the report to say what was done and what the window showed afterwards, so that I pass on only facts.

- The report states whether the task completed, was stopped, or was cancelled.
- The report lists each step that ran, with its action and its target.
- The report states the result as the window showed it after the agent's last plan. The agent judges that window itself; no check written before the plan decides it (decision PS-D19).
- When the task stops early, the report states the step and the reason.

### VU-03: Stop instead of guessing

As a user, I want a wrong or uncertain action to stop the task with a stated reason, so that errors do not compound.

- A step whose UI element is not in the window, or whose UI element the grounder cannot choose with confidence, stops before any input with a named reason.
- Code never repeats an action. Each step acts once, and the agent decides from the window after the plan whether anything needs doing again.
- An action that could have happened but whose outcome is unknown is never sent again.
- Nothing is checked before a step, so no step is skipped or stopped because the window already looks done (decision PS-D19).
- An unavailable decision service stops the task. The planning model does not take over the steps.

### VU-04: Never act beyond the permission I set

As a user, I want to choose whether the agent's plans are checked before they run, and to approve a checked plan before it sends anything to another person, service or account, so that the agent never acts beyond the permission I set.

- There are two permission check modes. The mode `none` checks nothing. The mode `online` checks each plan with an online model before the plan's first step (decision PS-D53).
- I can turn the check off or on in the task's own words, such as "without permission checks" or "ask me before anything is sent" (decision PS-D54).
- When the task does not say, the mode is the one in my configuration, and `none` when I have not set one.
- In the mode `online`, a plan waits for my approval when one of its steps has an effect that leaves the guest, such as sending a message, placing an order or changing an online account.
- The task can name further kinds of step that need my approval, such as adding items to a cart.
- When the online model fails or gives no usable answer, every step of the plan needs my approval.
- I approve or decline the whole plan once, in the main session's dialog, before the plan reads the window or sends anything. An approved plan runs to its end without stopping.
- When I decline the plan, or nobody can be asked, nothing in the plan is sent, and the report says why.
- Neither the plan nor the agent that delegated the task can approve a plan.
- Destroying data inside the guest, which is discarded after the task, needs no approval.
- The online model receives the task and the plan, including any text a step types. It receives no window text.

### VU-05: Report results from this task's own actions

As a parent agent, I want a reported result to come from the actions of this task, so that an old screen is not reported as new work.

- When the screen already shows the requested result before the agent acts, the report says so and does not claim that the agent produced it.
- A result that the report states comes from the window read after this task's last plan, not from a window read before the task acted.

This story comes from a live check in which the planner answered from a display left over from an earlier run and called the answer verified ([research Section 12.2](../research/vm-use-s0-s1.md#122-pi-tasks-with-the-fixes-in-place)).

### VU-06: Leave evidence a person can review

As a maintainer, I want every step to leave evidence, so that I can find why a task failed and approve a result.

- Each step's record lets a maintainer decide whether a failure came from finding the UI element or from choosing it.
- When step pictures are enabled, each action has a picture of the target window before and after it, and a review page lists them with each step's action.
- Records and pictures that may show window contents or typed text stay in local, ignored storage, and typed text can be redacted.
- Recorded evidence is labelled as evidence. It is never presented as a person's approval.

### VU-07: Keep the user's desktop out of reach

As a user, I want the agent to work only in a disposable virtual machine, so that it cannot disturb my own work.

- The agent cannot operate this machine's desktop, and no setting changes that (decision PS-D49).
- The agent does not launch applications. A task whose target application is not open stops with a named reason.

### VU-08: Review what the agent was asked, said and did

As a maintainer reviewing a run, I want one trajectory that puts the agent's side next to the machine's side, so that I can tell whether a failure started in the prompt, in the agent's reasoning or in the machine.

- The trajectory starts with the prompt that spawned the agent, and shows each later message from the parent where it arrived.
- The agent's messages and tool calls appear in the order its session recorded them. The session is the trajectory's only source of items.
- Each plan the agent ran is shown step by step under its tool call, before the result the agent received. A plan step shows what the grounder decided and the machine steps it ran, with their pictures.
- In the mode `online`, the plan's tool call shows what the online model answered for each step, which steps needed approval and why, whether a person was asked, their answer, and how long the answer took.
- A plan step that sent nothing, such as a step of a plan that a person declined or a step that never ran, is shown as well.
- Each step shows whether the agent did it in the host or it ran in the guest machine, and how long each step lasted. The time before each step started, from the end of the step before it or from the start of the step that contains it, is shown between them.
- Machine steps that no plan step or observation asked for, such as the checks after the agent's run, are counted in the Overview.
- An agent that was resumed on a second machine shows both machines in one trajectory.
- The trajectory is labelled as recorded evidence, not as a person's review, and it stays in local, ignored storage.

This story comes from decisions [PS-D17 and PS-D18](../decisions.md): the relay's viewer shows only the steps in the machine, so the viewer moves into the vm-use extension. Decision [PS-D40](../decisions.md) makes the session the source and extends it with the extension's records, because a wait for approval reaches no machine.

### VU-09: Operate the computer the way the person asked

As a person who asks for computer work in the chat, I want the vm-use agent to operate the computer as a person does, unless I ask to test accessibility features, so that my task is done as my own input would do it and an accessibility test exercises the accessibility functions.

- A person who asks for a task to be done gets input events only. No accessibility action reaches the machine for the task.
- A disabled person who asks for a task to be done is served the same way. A mention of a disability or an assistive technology, such as VoiceOver, does not change the input.
- An accessibility QA tester who asks to test accessibility features gets accessibility actions.
- The delegated request reaches the grounder as written, and the grounder chooses each action. Nothing translates one input into the other, and no check stops the task for its input.
- The step results name each step's action.

This story comes from decisions [PS-D31, PS-D32 and PS-D39](../decisions.md).

## 3. Out of Scope

- Tasks that span several applications in one plan.
- Web automation inside a browser page through a browser protocol. The agent sees a browser only through its accessibility tree.
- Degraded operation in which the planning model performs steps when the decision service is unavailable.

## 4. Decisions

| Decision | Outcome |
| --- | --- |
| Approve VU-01 to VU-07. | Approved as written on 2026-09-24. |
| Should VU-05 require the agent to act again when the result is already on screen, or only to say that it did not act? | Settled by VU-05 as approved: the report says that the result was already on screen, and the agent does not claim it. |
| Revise VU-04 for the permission check modes. | Revised for the owner's decisions PS-D53 and PS-D54 on 2026-10-05. The owner has not approved the revised text. |
| Add VU-08. | Added by the owner's decision PS-D17 on 2026-09-30, and revised by PS-D40, PS-D41, PS-D43 and PS-D44 on 2026-10-03. |
| Add VU-09. | Added by the owner's decisions PS-D31 and PS-D32 on 2026-10-01, and revised by PS-D39 on 2026-10-02. |
| Does the parent's view of a running vm-use agent need its own interaction design? | Open. The recommendation is yes: the fleet view should show the current step and the last check, which the subagent interaction design does not cover. |
