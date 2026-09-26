# Owner Decisions

**Document type:** Decision log.

**Scope:** This log records decisions that the owner made. Each entry states the decision, the reason given, and the design section that carries it out.

| ID | Date | Decision | Reason | Design |
| --- | --- | --- | --- | --- |
| PS-D2 | 2026-09-26 | An agent definition may set the child's thinking level with an optional `thinking` field. | Some child models, such as Qwen 3.8 27B, have a known thinking problem, so a definition must be able to turn thinking off or choose a level instead of inheriting the parent's. | [Subagents §5.3](arch/subagents.md#53-model-fallback-lists) |
