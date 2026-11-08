# Owner Decisions

**Document type:** Decision log.

**Scope:** This log records decisions that the owner made. Each entry states the decision, the reason given, and the design section that carries it out.

| ID | Date | Decision | Reason | Design |
| --- | --- | --- | --- | --- |
| PS-D2 | 2026-09-26 | An agent definition may set the child's thinking level with an optional `thinking` field. | Some child models, such as Qwen 3.8 27B, have a known thinking problem, so a definition must be able to turn thinking off or choose a level instead of inheriting the parent's. | [Subagents §5.3](arch/subagents.md#53-model-fallback-lists) |
| PS-D3 | 2026-11-08 | [User] Fix and test built-in tool inheritance architecturally so child agents receive codemode support like the main agent. | Tool-name inheritance without built-in extension construction makes every delegated child fail when the parent activates codemode. | [Subagents §8.1](arch/subagents.md#81-resource-and-tool-policy) |
| PS-D4 | 2026-11-08 | [Agent] Supply pi's public built-in tool-extension factories as built-in descriptors to each fresh child resource loader, with feature detection for hosts that predate those factories. | The descriptor form preserves built-in enablement and replacement semantics, while fresh loaders preserve child isolation and per-attempt disposal. | [Subagents §8.1](arch/subagents.md#81-resource-and-tool-policy) |
| PS-D5 | 2026-11-08 | [Agent] Keep the declared 0.85.1 development baseline and run the built-in inheritance regression against the installed pi 1.5.0 runtime without migrating the whole repository to the 1.5.0 type surface. | The runtime defect is separable from the broader SDK type migration, and feature detection keeps the fix backward-compatible. | [Subagents §8.2](arch/subagents.md#82-supported-pi-apis-and-compatibility-tests) |
| PS-D6 | 2026-11-08 | [User] Drop backward compatibility and make pi-secretary unavailable on pi versions older than 1.5.0. | The project targets the installed host and does not need runtime feature detection or legacy test skips. This supersedes PS-D4 and PS-D5. | [Subagents §8.2](arch/subagents.md#82-supported-pi-apis-and-compatibility-tests) |
