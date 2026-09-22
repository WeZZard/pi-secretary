# Implementation Plan: Nested Drill Levels, Nested Stop, and Promoted Completion

| Field | Value |
| --- | --- |
| Date | 2026-09-23 |
| Status | Proposed; not started |
| Revision under test | `dc36669b47ae22bb14f162414a3bde295b51a30f` |
| Owner | Unassigned |
| Verifying report | `.reviews/nested-subagent-test-walkthrough.md` |

## 1. Objective

This plan implements the `SA-12` clauses that were added to the design documents on 2026-09-23. It fixes the four nested-subagent defects recorded in the walkthrough report and turns the four failing reproducer test cases into passing regression tests.

## 2. Design decisions implemented by this plan

Each phase cites the document clause it implements. This plan introduces no product behaviour that is not already specified in these clauses.

| Clause | Document |
| --- | --- |
| A nested agent that itself delegates is inspectable as a further drill-down level. | `docs/user-stories/subagents.md`, `SA-12` |
| One nested agent can be stopped from its drill level without stopping its parent or its siblings. | `docs/user-stories/subagents.md`, `SA-12` |
| A nested outcome is not lost when its delegating session has ended. | `docs/user-stories/subagents.md`, `SA-12` |
| Deeper inspection is available from the overlay. | `docs/ux/subagents.md` section 3.1 |
| `X` stops the selected agent at the current drill level, including a nested agent. | `docs/ux/subagents.md` section 3.3 |
| A nested outcome whose owning session has ended is presented by a live ancestor. | `docs/ux/subagents.md` section 6 |
| A nested run still active at owner shutdown is cancelled; a terminal nested run keeps its completion record for promotion. | `docs/arch/subagents.md` section 7.4 |
| A nested outcome is delivered to its delegating session, and promoted to the nearest live ancestor when that session has ended. | `docs/arch/subagents.md` sections 10.1 and 10.2 |
| Promotion changes the recipient, not the recorded parentage. | `docs/arch/subagents.md` section 11.2 |
| The overlay retains the whole delegation tree of the current session, and an action target is evaluated against the agent record. | `docs/arch/subagents.md` section 12.1.6 |
| Drill-level tests use records produced by the service. | `docs/arch/subagents.md` section 12.5 |
| The overlay row set is the session's delegation tree. | `docs/arch/subagents.md` section 12.6.3 |
| Verification covers drill-in at every level, nested stop, and promoted completion. | `docs/arch/subagents.md` section 14 |
| Nested verification must not rely on fixtures that omit the owning session identity. | `docs/user-stories/subagents.md` section 4 |

## 3. Current state and root cause

The service already produces the design-correct row set. `AgentService.tree()` returns the session's own agents followed by their descendants, and it reads live descendant rows from the owning child session's service and static rows from storage when the owner has ended (`extensions/secretary/agents/service.ts` section "Snapshots for the whole delegation tree (SA-12)", around line 202).

The interface does not consume it. The port declared in `extensions/secretary/agents/ui/effects.ts` exposes `list()` only, and the dispatch in `extensions/secretary/agents/ui/commands.ts` around line 55 feeds the reducer from `port.list()`. The reducer then filters by `s.agent.parentId === event.parentId` at `extensions/secretary/agents/ui/reducer.ts` lines 34 and 39. A nested record carries the owning child session identity in `parentId`, so the filter removes it.

The same identity confusion causes the lifecycle and completion defects.

| Defect | Root cause | Exercising case |
| --- | --- | --- |
| `D-1` | The overlay receives `list()` instead of `tree()`, and the reducer filters by session identity. | `TC-01` |
| `D-2` | The rows needed for a level are dropped before `overlayRows` runs. | `TC-02` |
| `D-3` | `stopTargets` and `eligible` compare the agent's owning session with the capturing session, and the command builds candidates from `list()` filtered by session identity (`commands.ts` around line 192). | `TC-03` |

The same identity confusion also affects completion surfacing, but that is a proposed behaviour rather than a defect. Neither the original `SA-12` nor the original Section 10.1 required a nested outcome to survive the end of its delegating session; the original specification delivered a background outcome to the owning parent and stopped there. Phase 3 therefore proposes a behaviour instead of repairing one. It is recorded as `ACC-SA-01-09` under the `@proposed` tag, which marks a design-policy proposal and must not be treated as a user approval, and it follows the researched Claude Code behaviour in which a late nested background agent reports to the main conversation.

| Addition | Current mechanism | Exercising case |
| --- | --- | --- |
| `D-4` | The completion write at `service.ts` around line 460 keys the record to the owning session, and `pendingCompletions()` around line 725 reads only the current session's rows, so a settled outcome whose owning session has ended has no reader. | `TC-05`, `ACC-SA-01-09` |

## 4. Non-goals

- This plan does not change the model-facing tool schemas for `Agent`, `SendMessage`, `TaskStop`, or `TaskOutput`.
- This plan does not add a discovery tool, a filesystem watcher, or automatic child launch.
- This plan does not change the maximum nesting depth or its configuration.
- This plan does not claim real-provider behaviour or human visual approval.

## 5. Work breakdown

### Phase 0: Expose the delegation tree to the interface

- **Deliverable:** The user-interface port can supply the session's delegation tree.
- **Files:** `extensions/secretary/agents/ui/effects.ts`, `extensions/secretary/agents/installation.ts`.
- **Tasks:**
  - Add `tree(): AgentSnapshot[]` to `AgentUIPort`, keeping `list()` for the indicator view models.
  - Supply `tree: () => service.tree()` at the port construction site in `installation.ts` around line 73.
- **Tests:** A port-shape test that the tree source returns descendants for a session that has a nested agent.
- **Exit criteria:** The port exposes the tree, and `list()` behaviour is unchanged, so `fleet-view.test.ts` and `ui.test.ts` still pass.
- **Citations:** `docs/arch/subagents.md` section 12.6.3.

### Phase 1: Retain the delegation tree and derive levels from it

- **Deliverable:** The overlay lists nested children as a drill level with production record shapes.
- **Files:** `extensions/secretary/agents/ui/commands.ts`, `extensions/secretary/agents/ui/reducer.ts`, `extensions/secretary/agents/ui/state.ts`.
- **Tasks:**
  - Feed the reducer from `port.tree()` for the `activate` and `snapshot` events.
  - Replace the session-identity filter in the reducer with the retained-row rule from the design, namely the session's own children plus every descendant reachable through parent agent identity, and keep `overlayRows` keyed on `parentAgentId`.
  - Confirm that `fleetRows` still excludes nested rows, because it already filters on the absence of `parentAgentId`.
- **Tests:**
  - `TC-01` and `TC-02` in `tests/agents/nested-ui-repro.test.ts` must pass.
  - Add `TC-06` for drilling two levels, using a depth-three tree from `tests/support/nested-real-tree.ts`.
  - Keep the indicator assertion in `tests/agents/fleet-view.test.ts` line 67 passing.
- **Exit criteria:** `TC-01`, `TC-02`, and `TC-06` pass against records produced by the real service, and no acceptance scenario regresses.
- **Citations:** `docs/user-stories/subagents.md` `SA-12`; `docs/ux/subagents.md` sections 2.4 and 3.1; `docs/arch/subagents.md` sections 12.1.6 and 12.6.3.

### Phase 2: Evaluate action targets against the agent record

- **Deliverable:** The overlay can stop one nested agent without stopping its parent or its siblings.
- **Files:** `extensions/secretary/agents/ui/state.ts`, `extensions/secretary/agents/ui/reducer.ts`, `extensions/secretary/agents/ui/commands.ts`, `extensions/secretary/agents/service.ts`.
- **Tasks:**
  - Extend the action target so it carries both the capturing session and the owning session, as specified in section 12.1.6.
  - Build `stopTargets` from the overlay rows and use the agent's own record identity, and evaluate `eligible` against the agent record rather than by comparing session identity.
  - Build the `/agents stop` candidate list from the tree so a nested agent is selectable.
  - Confirm that `AgentService.stop` accepts a nested run identity and routes the request to the owning session, following the owner-routing pattern that worktree cleanup already uses.
- **Tests:**
  - `TC-03` in `tests/agents/nested-ui-repro.test.ts` must pass.
  - Add assertions that the parent and siblings remain running.
  - Keep `tests/agents/fleet-cancellation.test.ts` and the sibling-isolation coverage in `tests/agents/nested-delegation.test.ts` passing.
- **Exit criteria:** The interface stops exactly the selected nested agent, and the service-level stop cascade, sibling isolation, and captured-identity behaviour are unchanged.
- **Citations:** `docs/user-stories/subagents.md` `SA-12`; `docs/ux/subagents.md` section 3.3; `docs/arch/subagents.md` sections 7.4 and 12.1.6.

### Phase 3: Promote a nested completion to a live ancestor

- **Deliverable:** A nested outcome reaches the top-level conversation when its delegating session has ended.
- **Files:** `extensions/secretary/agents/service.ts`, `extensions/secretary/agents/storage/agent-repository.ts`, and, only if needed, `extensions/secretary/agents/records.ts`.
- **Tasks:**
  - Resolve the delivery recipient for a nested completion at read time: prefer the delegating session while it is live, and otherwise walk to the nearest live ancestor, with the main session as the final recipient.
  - Persist a promotion marker so the completion is delivered once and `recordDelivery` can still find it by its stable identifier.
  - Keep the record's run identity and recorded parentage unchanged, so external consumers and deduplication are unaffected.
  - Confirm that a nested run still active when its owning session shuts down is cancelled, and that a terminal nested run keeps its completion record.
- **Open questions to resolve during implementation:**
  - Whether the promotion marker is a new column on the completion record or is derived from owner liveness at read time.
  - Whether promotion must also update the owning session's own record or only the promoted copy.
- **Tests:**
  - `TC-05` in `tests/agents/nested-output-repro.test.ts` must pass.
  - Keep `TC-04` passing, so output retrieval is proven separate from completion delivery.
  - Add a deduplication assertion that the promoted outcome is presented once.
- **Exit criteria:** The main session's pending completions contain the nested outcome exactly once, the nested record's parentage is unchanged, and no completion turn is duplicated.
- **Citations:** `docs/user-stories/subagents.md` `SA-12`; `docs/ux/subagents.md` section 6; `docs/arch/subagents.md` sections 7.4, 10.1, 10.2, and 11.2.

### Phase 4: Acceptance specifications, bindings, and hashes

- **Deliverable:** Executable acceptance coverage for the amended contract.
- **Files:** `doc/acceptance/agent-inspection.feature`, `doc/acceptance/cancellation.feature`, `doc/acceptance/delegation.feature`, `doc/acceptance/README.md`, `tests/acceptance/ui.test.ts`, `tests/acceptance/runtime.test.ts`, `tests/acceptance/ui-harness.ts`.
- **Tasks:**
  - Amend `ACC-SA-02-13` so its Given establishes that A launched its children through the delegation contract, which makes the owning session identity visible to the binding.
  - Add `ACC-SA-02-15` for drilling through two nested levels and returning to the root with Left.
  - Add `ACC-SA-04-08` for stopping one nested agent, cancelling the agents it launched, and leaving its parent and siblings running.
  - Add `ACC-SA-01-09` for delivering a nested outcome after its delegating session has ended, exactly once, with parentage unchanged.
  - Update the requirement tags in the acceptance inventory rows.
  - Correct the `snapshot()` fixture in `tests/acceptance/ui-harness.ts` so nested records carry the owning session identity, and rebuild `ACC-SA-02-13` on records from the real service where the scenario allows it.
  - Update the frozen source hashes through the `runFeatures(..., hashes)` maps in `tests/acceptance/ui.test.ts` and `tests/acceptance/runtime.test.ts` after reviewing each changed assertion.
- **Tests:** `npm run test:acceptance` and `npm run lint:acceptance`.
- **Exit criteria:** Every new scenario has a binding, every hash matches its reviewed specification, and no scenario passes only because of a fixture that contradicts the production record shape.
- **Citations:** `docs/user-stories/subagents.md` section 4; `docs/arch/subagents.md` sections 12.5 and 14.

### Phase 5: Verification report and walkthrough

- **Deliverable:** Recorded execution evidence.
- **Files:** `docs/testing/subagent-verification.md`, `.reviews/nested-subagent-test-walkthrough.md`.
- **Tasks:**
  - Record the executed commands, the revision, the pass and fail counts, and the remaining limits.
  - Update the walkthrough so the reproducer cases are shown as passing, the assumption table reflects the fixed behaviour, and the rendered diagrams still match the design.
  - Keep run output under `test-results/` and out of version-controlled documentation.
- **Exit criteria:** The verification report distinguishes executed checks from the remaining unverified limits, and the walkthrough no longer states a behaviour that contradicts the code.
- **Citations:** `docs/README.md` documentation responsibilities; project rule on generated test artifacts.

## 6. Test plan

- **Reproducers that must flip from failing to passing:** `tests/agents/nested-ui-repro.test.ts` (`TC-01`, `TC-02`, `TC-03`) and `tests/agents/nested-output-repro.test.ts` (`TC-05`).
- **Guard that must stay passing:** `TC-04` in `tests/agents/nested-output-repro.test.ts`.
- **New case:** `TC-06`, the two-level drill, in `tests/agents/nested-ui-repro.test.ts` with a depth-three tree from `tests/support/nested-real-tree.ts`.
- **Regression suites:** `tests/agents/ui.test.ts`, `tests/agents/fleet-view.test.ts`, `tests/agents/keybindings.test.ts`, `tests/agents/inspector.test.ts`, `tests/agents/nested-delegation.test.ts`, `tests/agents/fleet-cancellation.test.ts`, `tests/agents/service.test.ts`, `tests/agents/runner.test.ts`, `tests/agents/schemas.test.ts`, `tests/agents/standalone.test.ts`, and `tests/acceptance/ui.test.ts`.
- **Commands:**
  - `node --experimental-strip-types --test --test-concurrency=1 tests/agents/nested-ui-repro.test.ts tests/agents/nested-output-repro.test.ts`
  - `npm test`
  - `npm run test:acceptance`
  - `npm run lint:acceptance`
  - `npm run lint:mermaid`
  - `npm run verify`

## 7. Exit criteria

- All four reproducers pass deterministically on two consecutive runs.
- The new depth-three case passes.
- No acceptance scenario passes only because a fixture contradicts the production record shape.
- Every phase cites the design clause it implements, and no implemented behaviour is unspecified.
- The verification report and the walkthrough agree with the executed results.
- `npm run verify` exits zero.

## 8. Risks

- **Fixture correction changes existing results.** Rebuilding `ACC-SA-02-13` on production-shaped records may require adjusting assertions that currently depend on the fixture, so the hash review in Phase 4 must check each changed assertion rather than only recomputing the hash.
- **Promotion could duplicate a completion turn.** The design permits one follow-up turn per live session, so Phase 3 must add a deduplication assertion and keep the recorded parentage stable.
- **Owner-dead nested runs may still be active.** Section 7.4 states that a nested child never outlives its parent's session, so Phase 3 must verify the shutdown path rather than assume that every orphaned nested run is already terminal.
- **Deriving the retained row set may be more expensive than the current filter.** `tree()` reads live child services and storage, so Phase 0 should confirm that the snapshot path remains non-blocking as required by section 12.6.3.

## 9. Rollout and review

- Land the phases in order, because Phase 1 changes the row set that Phases 2 and 3 depend on.
- Ask a human reviewer to confirm the `D-4` decision recorded in the requirements before Phase 3 begins, because that clause changes user-visible delivery behaviour.
- Ask a human reviewer to approve the amended acceptance scenarios, because a specification change requires review rather than an automatic hash update.
- Record the human review separately from the executed test evidence, in line with the documentation guide.
