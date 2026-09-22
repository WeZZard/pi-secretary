# Subagent Acceptance Specifications

**Document type:** Behavior-driven development (BDD) acceptance specifications.

**Status:** The specifications have executable scenario bindings. Test execution and terminal evidence are recorded in the [verification report](../../docs/testing/subagent-verification.md); the specifications alone are not proof of passing behavior.

## 1. Purpose

- These specifications describe Secretary's subagent behavior using Gherkin `Feature`, `Scenario`, `Scenario Outline`, and Given/When/Then steps.
- They cover user-visible outcomes and model-facing tool behavior rather than prescribing database tables or SDK implementation details.
- They trace back to the [subagent requirements](../../docs/user-stories/subagents.md), [interaction design](../../docs/ux/subagents.md), and [technical design](../../docs/arch/subagents.md).
- This directory uses the explicitly requested `doc/acceptance/` path. The existing design documents remain under `docs/`.

## 2. Approval and Execution Status

- The `@draft` tag applies to every feature and identifies specifications that still require review.
- The `@confirmed` tag identifies a scenario derived directly from a confirmed design constraint. It does not mean its steps have been implemented or its outcome has been verified.
- The `@proposed` tag identifies a scenario that depends on a detailed policy proposed in the design. These scenarios must not be treated as additional user approvals.
- Every scenario has exactly one of `@confirmed` or `@proposed`.
- The `@SA-01` through `@SA-13` tags identify the corresponding requirement where covered by these specifications.
- The `@ACC-SA-...` tags provide stable scenario identifiers for review and later automation.
- The `@ui`, `@concurrency`, `@recovery`, and `@compatibility` tags classify scenarios without changing their approval status.
- `npm run test:acceptance` executes the compiled scenarios and all Examples rows through the scenario-specific adapters in `tests/acceptance/`.
- The adapters exercise production services, installed tools, real SDK sessions, Git repositories, and UI state/effect boundaries as appropriate. They are not a generic natural-language step interpreter.
- Each feature has a reviewed source hash. A changed specification, missing binding, or obsolete binding fails the suite instead of silently retaining old assertions.
- `npm run lint:acceptance` remains a separate syntax and identity check. It does not execute behavior.

## 3. Feature Inventory

| Feature file | Requirements | Scope |
| --- | --- | --- |
| [delegation.feature](delegation.feature) | SA-01 and SA-12. | The scenarios cover foreground and background delegation, fresh context, queue admission, tool availability, and delivery of a nested outcome whose delegating session has ended. |
| [agent-configuration.feature](agent-configuration.feature) | SA-07. | The scenarios cover definitions, stable model schemas with runtime list publication, inheritance, project trust, and tool restrictions. |
| [agent-discovery.feature](agent-discovery.feature) | SA-13. | The scenarios cover first-request discovery, request-scoped definitions during edits, and recovery without parent filesystem probing. |
| [messaging.feature](messaging.feature) | SA-03. | The scenarios cover guidance, resumption, delivery acknowledgment, and concurrent requests. |
| [cancellation.feature](cancellation.feature) | SA-04 and SA-12. | The scenarios cover stopping, stopping an individual nested agent from its drill level, foreground interruption, wait cancellation, and stale confirmations. |
| [session-recovery.feature](session-recovery.feature) | SA-05. | The scenarios cover exit, reload, session ownership, restoration, and recovery after failure. |
| [worktree-isolation.feature](worktree-isolation.feature) | SA-06. | The scenarios cover worktree allocation, retained changes, cleanup, and resumption races. Shared-directory defaults and non-Git directory snapshots are covered by the E2E matrix rather than this feature file. |
| [agent-inspection.feature](agent-inspection.feature) | SA-02 and SA-12. | The scenarios cover FleetView, transcript inspection, multi-level drill-down, focus, scrolling, and accessible status presentation. |
| [ui-state-machine.feature](ui-state-machine.feature) | SA-02 through SA-06. | The scenarios cover modal transitions, stable targets, duplicate submission, uncertain acknowledgment, and stale responses. |
| [goal-integration.feature](goal-integration.feature) | SA-08. | The scenarios cover attributed usage, automatic goal authority, completion, and continuation. |
| [goal-agent-composition.feature](goal-agent-composition.feature) | SA-08. | The scenarios cover fresh delegated recovery while a goal remains blocked and standalone delegation without goal management. |
| [output-and-headless.feature](output-and-headless.feature) | SA-01, SA-02, and SA-09. | The scenarios cover output retrieval, truncation, waiting, and behavior without a terminal. |

## 4. Scenario Conventions

- Each scenario starts with isolated parent sessions, configuration, storage, and repositories unless its Given steps explicitly establish shared state.
- Names such as `reviewer`, agent IDs, and model identifiers represent fixtures. They do not require access to a particular provider or network service.
- A deterministic test provider should control message completion, failure, usage, and cancellation when these scenarios are automated.
- “Before completion” means that the child is held at a controlled execution point. Tests must not depend on arbitrary sleeps.
- “At the same time” means that the test exercises both relevant operation orderings with synchronization barriers or another deterministic concurrency technique.
- A resumable agent is a custom agent or another definition marked resumable in the design. Packaged one-shot agents are not assumed to be resumable.
- An accepted operation, a delivered message, a completed run, and successful task completion are different observations.
- A recorded status is checked through a public tool result or the inspector. Tests must not infer completion from assistant prose alone.
- Worktree scenarios use disposable Git repositories. They must never modify the user's checkout or remove real worktrees.
- UI scenarios verify visible outcomes and input behavior. They do not claim that a user read or acknowledged a display merely because it rendered.

## 5. UI State-Machine Traceability

- The [architectural transition table](../../docs/arch/subagents.md#1214-transition-rules-and-feedback) is the authoritative specification of UI states, guards, and effects.
- The [UX interaction flow](../../docs/ux/subagents.md#5-visible-interaction-flow) describes the corresponding user actions and visible outcomes without duplicating that state-machine specification.
- The [technical transition contract](../../docs/arch/subagents.md#122-events-guards-and-effects) specifies state changes and emitted effects without placing implementation logic in Gherkin steps.
- The following table identifies representative acceptance scenarios for each transition. Reducer tests must also cover guard rejection and prohibited effects.

| Transition | Acceptance coverage |
| --- | --- |
| UI-01. | ACC-SA-02-02 and ACC-SA-02-03 cover activation and preservation of ordinary editing. |
| UI-02. | ACC-SA-02-02 and ACC-SA-UI-13 cover opening a selected agent and load failure. |
| UI-03. | ACC-SA-UI-02 and ACC-SA-UI-13 cover correlated and stale transcript responses. |
| UI-04. | ACC-SA-UI-01 and ACC-SA-UI-07 cover composer entry and stable recipient behavior. |
| UI-05. | ACC-SA-UI-03 covers duplicate input while a submission is pending. |
| UI-06. | ACC-SA-UI-04 and ACC-SA-UI-05 cover definitive rejection and uncertain acceptance. |
| UI-07. | ACC-SA-04-02 and ACC-SA-06-05 cover confirmed stop and cleanup outcomes. |
| UI-08. | ACC-SA-UI-08, ACC-SA-UI-09, and ACC-SA-06-06 cover changed targets and ordinary progress. |
| UI-09. | ACC-SA-UI-06 and ACC-SA-UI-12 cover dismissal and restoration of originating focus. |
| UI-10. | ACC-SA-UI-07, ACC-SA-UI-11, and ACC-SA-02-08 cover progress, completion, and resize. |
| UI-11. | ACC-SA-UI-01 and ACC-SA-02-04 cover closing the inspector without cancellation. |
| UI-12. | ACC-SA-UI-10 covers deactivation and stale responses after session replacement. |

## 6. Usage Examples

- The usage values in the goal-accounting examples are synthetic fixture inputs, not benchmark measurements.
- Every expected goal-budget value uses the existing formula: `max(inputTokens - cachedInputTokens, 0) + max(outputTokens, 0)`.
- Fixture inputs are already normalized to Secretary's `TokenUsage` semantics. Separate technical tests must verify provider-specific normalization.
- Context-window usage, provider token totals, and goal-budget token usage must not be substituted for one another.

## 7. Automation and Review

- Each scenario identifier is bound by `tests/acceptance/runtime.test.ts`, `configuration-goals.test.ts`, `composition.test.ts`, `discovery.test.ts`, `ui.test.ts`, or `worktrees.test.ts`. The shared runner uses the official Gherkin compiler to expand Examples rows.
- The [terminal recording procedure](tui-recording.md) supplements UI adapter tests with actual terminal input and output. Human approval remains a separate review. Real-provider spawning scenarios are described in the [E2E testing guide](../../docs/testing/subagent-e2e.md) and are not part of this Gherkin suite.
- Keep generated run output under ignored `test-results/` or in CI artifact storage, as specified in the [test artifact policy](../../docs/testing/test-artifacts.md). This directory contains versioned specifications and instructions, not generated evidence archives.
- The configuration-precedence fixture uses the real packaged `general-purpose` definition. Its former `reviewer` name incorrectly assumed a packaged agent that the design does not include; the behavioral precedence requirement is unchanged.
- Automated checks should distinguish schema validation, service integration, real pi host integration, and TUI interaction tests.
- The blocked-recovery binding in `tests/acceptance/composition.test.ts` uses an adapter parent and real SDK children. The separate `tests/integration/goal-agent-composition.test.ts` regression exercises real parent SDK ingress, registered tools, and child completion. The standalone acceptance binding uses real parent and child SDK sessions without installing goal management. These checks do not establish human approval.
- UI review should follow the project's recording procedure when an implementation is available. The review must distinguish recording completeness, execution outcome, and human approval.
- A scenario that exposes a new product decision must update the owning requirements or design document before implementation.
- Deliberate deviations from Claude Code must remain documented in the technical design and must not be hidden in test fixtures.
- These specifications do not replace schema conformance fixtures, security tests, or resource cleanup tests defined in the technical design.
