# Subagent Model Inheritance Investigation Plan

## Scope

- Investigate only model inheritance for dynamically launched children.
- Preserve the precedence and resumption rules in [architecture Section 5.3](../docs/arch/subagents.md#53-model-fallback-lists).
- Record evidence and uncertainty in the [model inheritance investigation](../docs/research/subagent-model-inheritance.md).
- Do not change production behavior without a deterministic failing-before/passing-after real-SDK reproducer.

## Completed work

- [x] Read the troubleshooting instructions, project documentation guidance, and relevant Pi SDK, extension, model, provider, and session-format documentation.
- [x] Extend `tests/support/discovery-session.ts` with multiple local fixture models and provider-boundary model capture.
- [x] Add `tests/agents/model-inheritance.test.ts` to exercise the current-model inheritance contract in architecture Section 5.3 through real parent and child SDK sessions.
- [x] Verify that a post-startup parent model switch controls new inherited launches even when the settings default differs from both parent models.
- [x] Verify that definition and explicit tool overrides retain their documented precedence.
- [x] Run the focused model and discovery suites and TypeScript checking.
- [x] Document the passing baseline, unchanged production code, and verification limits in the investigation.

## Incident-shaped follow-up

- [x] Read matching saved ten-agent batches without modifying user state. Their main requests used `litellm/kimi-k3-256k`, their tool calls omitted `model`, and their retained `general-purpose` definition selected `superior`, producing `litellm/gpt-6-astra` children.
- [x] Reproduce that definition override through real SDK sessions without switching the parent model. Change only the fixture definition's model field and verify that the next fresh child inherits the unchanged main model. This validates the precedence contract in architecture Section 5.3 rather than changing it.
- [x] Confirm that the current user-level `general-purpose.md` already omits the override. Preserve that file and all historical records. Clarify inheritance in the owning architecture and UX documents.
- [x] Run all six model tests and the complete verification gate. All 674 tests, TypeScript checking, 28 Mermaid blocks, and acceptance syntax validation pass.

## Exit criteria

- The inspected model mismatch is explained by a retained definition override, and the controlled experiment demonstrates how removing that override restores inheritance. It is not attributed to a parent model switch or SDK startup-default fallback.
- No production model-selection rewrite or user-configuration modification is claimed. The current general-purpose configuration already has the desired inheritance policy, and existing child conversations intentionally retain their recorded models.
- A different mismatch still requires its own execution evidence and deterministic reproducer. The tests do not establish arbitrary hosted-provider, nested, or interactive model-picker behavior.
