# Owner Decisions

**Document type:** Decision log.

**Scope:** This log records decisions that the owner made. Each entry states the decision, the reason given, and the design section that carries it out. Decisions recorded in another repository, such as relay decision D3 in `relay-driver/docs/decisions.md`, are cited where they are used and are not copied here.

| ID | Date | Decision | Reason | Design |
| --- | --- | --- | --- | --- |
| PS-D1 | 2026-09-24 | The relay backend is a client of an `mcp-vm-relay` server session and uses the official `@modelcontextprotocol/sdk` client. | The owner retired `pi-vm-relay` in favor of `pi-mcp-adapter` with `mcp-vm-relay`. | [Computer use §11.2](arch/computer-use.md#112-relay-client) |
| PS-D2 | 2026-09-26 | An agent definition may set the child's thinking level with an optional `thinking` field. The computer-use definition sets `thinking: off`. | Qwen 3.8 27B has a known thinking problem. Thinking stays off until enough run data exists to fine-tune the model. | [Subagents §5.3](arch/subagents.md), [computer use §4.3](arch/computer-use.md#43-integration-with-the-subagent-subsystem) |
| PS-D3 | 2026-09-26 | The button-name rule is removed. A check before a plan runs rejects only a plan that cannot run. It never rejects a plan on a guess about what the planner meant or about a future screen. | A check before the run understands only part of what the runtime supports. Rejecting everything outside that part rejects correct plans: in the Calculator task, the rule rejected "the display shows 7" three times, and the fallback left three of four steps unverified. | [Computer use §5.2](arch/computer-use.md#52-computer_run_plan) |
| PS-D4 | 2026-09-26 | Plans are built from the controls the observation offers. A step names its control by region, role and name. The runtime confirms the control in a fresh read before acting, and stops a plan whose window changed since the observation it was written against. | The plan is valid when it is built, and the runtime catches what changes afterwards. An independent review on 2026-09-26 found that the planner's output is not constrained by the tool schema, so the runtime check remains necessary. | [Computer use §5.2](arch/computer-use.md#52-computer_run_plan), [§9](arch/computer-use.md#9-step-lifecycle) |
