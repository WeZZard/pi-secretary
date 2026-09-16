# Documentation Guide

**Scope:** This guide defines the responsibilities of this project's requirements, UX design, architecture, and implementation plans. It does not change runtime behavior or global agent instructions.

## Document responsibilities

| Document | Audience and purpose | Contents that belong here | Contents that belong elsewhere |
| --- | --- | --- | --- |
| [User stories and requirements](user-stories/user-stories.md) | Product owners and reviewers decide what outcomes the product must support and why. | Include user or agent needs, observable acceptance criteria, scope, and explicit product constraints. | Put event schemas, SDK hooks, storage operations, and implementation sequencing in the architecture or plan. |
| [UX and interaction design](ux/ux-design.md) | Designers and reviewers describe the experience from the user's perspective. | Include user intent, available actions, visible outcomes, feedback, failure, recovery, and accessibility. | Put service calls, database changes, model-context injection, and queue-admission algorithms in the architecture. |
| [Technical architecture](arch/architecture.md) | Implementers define how the system satisfies the requirements and interactions. | Include interfaces, data models, component responsibilities, state transitions, synchronization, failure handling, and technical verification contracts. | Do not redefine the user's intended behavior merely because existing code behaves differently. Cite the UX contract instead. |
| [Implementation plans](../.plans/) | Implementers and reviewers organize delivery against an agreed design. | Include file targets, dependencies, tasks, tests, exit criteria, rollout, and citations to design decisions. | Do not introduce a new product behavior or technical protocol without updating and citing its owning design document. |
| [Research](research/) | Readers evaluate evidence, comparisons, and unresolved questions. | Include observations, sources, uncertainty, and recommendations. | Do not present an observation about current code as an approved product requirement. |

## Direction of justification

- Start with the required outcome, describe the interaction, choose the technical mechanism, and then plan the work.
- A defect in existing code can reveal a missing requirement. Restate that requirement independently of the existing implementation before updating the UX design.
- Keep a mechanism in its technical home and cite it where needed. Do not duplicate its algorithm in UX prose or acceptance stories.
- Distinguish intended design from observed implementation and verified behavior. A draft design and a checked-off documentation task do not imply a shipped feature.

## Interaction specification format

For each substantial interaction in the UX document, use the following fields:

- **User intent:** Explain the outcome the user wants to achieve.
- **Entry conditions:** Explain what the user needs to have or know before acting.
- **User action:** Describe the command, selection, or other action available to the user.
- **Observable outcome:** Describe what changes in the user's experience.
- **Feedback:** Specify what the interface communicates, including unsuccessful attempts.
- **Failure and recovery:** Explain what remains unchanged, what the user can do next, and any limits on recovery.

- Use interaction diagrams whose participants are the user and visible product surfaces. Put internal component sequence diagrams in the architecture document.
- Describe arguments in terms of what the user supplies and wants. For example, `<objective>` describes a desired outcome, not a request to set a database status.
- Do not invent a recovery control merely to complete the template. If a recovery action is not supported or decided, state that limitation.

## Review checklist

- Can a UX reader understand the interaction without knowing the implementation?
- Does each user-story criterion express a required outcome rather than a chosen mechanism?
- Are explicit technical compatibility constraints clearly separated from behavioral requirements?
- Does the architecture explain how the interactions are delivered, including failure and concurrency cases?
- Does each implementation phase cite the design decision it implements?
- Do revised links and section anchors still resolve?
- Have claims about current behavior been distinguished from intended behavior and test evidence?

## Example: an exhausted-budget resume

- **Requirement:** The user must not be told that work resumed when the goal has no remaining token budget.
- **UX:** After `/goal resume`, explain that the token budget is exhausted and keep `budget_limited` visible. Do not show “Goal resumed.”
- **Architecture:** The command adapter derives feedback from the service's resulting snapshot, and budget precedence prevents activation.
- **Plan:** Add a command-adapter regression test that checks the stored status, displayed status, and confirmation together.
