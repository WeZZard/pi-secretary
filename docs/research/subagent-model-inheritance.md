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

## Follow-up: the 2026-09-21 discord-session incident

- A second incident showed the same confusion from the opposite direction. A `discord-session` definition named the `computer-use` fallback list, and its children launched on `litellm/gpt-6-astra`, the parent's current model. The launch was reported as unwanted inheritance.
- The stored agent record is inconsistent with inheritance. It holds `model: litellm/gpt-6-astra` together with `modelCandidates: ["litellm/kimi-k3", "litellm/kimi-k3-256k"]`, and the launch result showed no skipped candidates. Inheritance produces a single-candidate chain and records no candidates, so the only consistent resolution state is a `computer-use` list whose first entry was `litellm/gpt-6-astra` at capture time, selected as candidate 1 of 3. Resolution behaved as Section 5.3 specifies.
- The user reported editing the list before that launch, yet the record proves the on-disk list still had `litellm/gpt-6-astra` at its head at capture time, so the edit was not persisted when the launch was admitted. A freshness review of the full path established two facts.
- The read side is fresh. The catalog and its execution configuration are captured from disk on every request, and a real-SDK test confirms that an on-disk edit between turns resolves in the very next launch. No caching in the resolution path can serve a stale list.
- The write side could silently lose the edit. The `/secretary` menu held the whole lists map in memory and rewrote it wholesale on every action, so any action in a menu opened before a newer external edit reverted that edit without a warning. `tests/agents/config-freshness.test.ts` reproduces the loss deterministically. Whether this mechanism consumed the user's pre-launch edit cannot be proven from the retained records; the defect is consistent with the observation and is now repaired by applying menu operations to freshly re-read lists at the persistence boundary, with conflicts reported as not-saved.
- The user-global `secretary.json` was rewritten after the incident with `litellm/gpt-5.6-luna` as the list's new first entry. This investigation did not modify that file.
- The defect this incident shares with the earlier one is observability, not selection. The launch result stated only `Model: litellm/gpt-6-astra`, so a correct list resolution whose first candidate is the parent model was indistinguishable from silent inheritance. Two investigations were spent on that ambiguity.
- The architectural repair records the resolution provenance on the agent record (interpreted value, origin, full chain, selected position, pre-launch skips) and states it on every result surface, for example `Model: litellm/gpt-6-astra (definition list 'computer-use', candidate 1/3)`. The repair is verified by `tests/agents/model-provenance.test.ts`, which reproduces the incident symptom through real parent and child SDK sessions and asserts the source label.

Reproduce with:

```sh
node --experimental-strip-types --test tests/agents/model-provenance.test.ts tests/agents/config-freshness.test.ts
```

## Resolution and limits

- Use an omitted model or `model: inherit` in a definition when fresh children should follow the main session. Do not supply an explicit model argument on the launch unless that override is intended.
- The inspected current `general-purpose` definition already satisfies this policy. After active children settle, reload the running extension to use the checked-out tool schema and cancellation controls.
- A resumed child retains its recorded model; it does not retroactively inherit a new definition. Launch a fresh agent when a new model policy is required.
- No live paid API, GUI model-picker operation, nested model propagation, or queued-launch model switch was executed in this focused investigation. No user configuration or historical execution record was rewritten.
