# Subagent Model Inheritance Investigation

## Status and scope

- This investigation examines the report that new agents use pi's startup default rather than the main session's model. The user clarified that no model switch was involved in the affected workflow.
- The tested repository baseline is `dc04e5c`, with the locally installed pi SDK `0.85.1`. No production model-selection code was changed.
- Initial real-SDK inheritance tests passed before any production change. Subsequent read-only inspection found matching ten-agent batches whose captured agent definition explicitly selected the `superior` fallback list.
- A controlled real-SDK experiment reproduced the resulting model difference without switching the parent model. Removing only the definition's override restored inheritance for the next fresh launch. This establishes a definition-policy cause for the inspected batches, not a startup-default fallback in the child SDK.

## Recorded evidence

- In the inspected repository session ending `f5780b431333`, the parent requests used `litellm/kimi-k3-256k`. The ten `Agent` calls omitted a model override, but their stored `general-purpose` definition snapshots contained `model: superior`. Their child records selected `litellm/gpt-6-astra`.
- The stored definition source was the user-level `general-purpose.md`. Several earlier repository batches retained the same override. Inspection extracted only model-selection and launch metadata; no task contents or generated user-session output are archived here.
- The current user-level `general-purpose.md` already omits its model override. This investigation did not modify that file or claim responsibility for its earlier change. Fresh no-override launches using that current definition can inherit; existing child conversations retain their recorded model.
- The running investigation conversation also exposes an older `Agent.model` enum schema, whereas the checkout exposes an optional unrestricted string. That is evidence of a loaded-code/version difference, not proof that stale code caused the recorded model mismatch.

## Existing contract and implementation

- [Architecture Section 5.3](../arch/subagents.md#53-model-fallback-lists) selects the explicit tool model first, then the definition model, then inheritance. Inheritance captures the active parent model at launch. Resumption retains the recorded child model.
- `installation.ts` passes the executing tool's context to model resolution. The SDK provides the context model through a getter for the current session model.
- `registry.ts` resolves inheritance from that model before asynchronous credential checks. `runner.ts` supplies the resolved model explicitly to `createAgentSession()`, rather than relying on settings defaults.
- A definition-level fallback list is an override even when the model omits the tool's optional `model` argument. Ignoring all such overrides would break the existing model-selection contract and is not a repair for this configuration issue.

## Deterministic verification

`tests/agents/model-inheritance.test.ts` exercises the real parent SDK session, dynamically registered `Agent` tool, catalog, resolver, service, child SDK session, and provider adapter. An isolated deterministic provider records actual parent and child model identifiers without network requests.

- The initial case distinguishes the parent startup model, a later selected model, and the configured settings default. Both fresh children use their respective current parent model.
- The incident-shaped case keeps the parent model unchanged, omits the tool override, and supplies a `general-purpose` definition with `model: superior`. The child uses that list's model. Removing only that definition field makes the next child use the unchanged parent model.
- Additional cases verify definition-level `inherit`, an explicit definition model, a tool override of a definition, and explicit tool-level `inherit` overriding a fixed definition model.
- All six model tests pass. The first five cases passed on unchanged production code; the controlled configuration experiment demonstrates the recorded override mechanism rather than a newly fixed runtime defect.

Reproduce with:

```sh
node --experimental-strip-types --test tests/agents/model-inheritance.test.ts
```

## Resolution and limits

- Use an omitted model or `model: inherit` in a definition when fresh children should follow the main session. Do not supply an explicit model argument on the launch unless that override is intended.
- The inspected current `general-purpose` definition already satisfies this policy. After active children settle, reload the running extension to use the checked-out tool schema and cancellation controls.
- A resumed child retains its recorded model; it does not retroactively inherit a new definition. Launch a fresh agent when a new model policy is required.
- No live paid API, GUI model-picker operation, nested model propagation, or queued-launch model switch was executed in this focused investigation. No user configuration or historical execution record was rewritten.
