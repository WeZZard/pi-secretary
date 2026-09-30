# Computer-Use Subagent: Interaction Design

**Document type:** UX and interaction specification.

**Status:** Draft. Section 1 specifies the trajectory viewer that decisions [PS-D17 and PS-D18](../decisions.md) call for. No other computer-use interaction is specified here yet.

**Related documents:** [Requirements](../user-stories/computer-use.md), [technical design](../arch/computer-use.md), and the [subagent interaction design](subagents.md).

## 1. Trajectory viewer

The trajectory viewer is the relay's review app, moved into the computer-use extension ([PS-D18](../decisions.md)). It keeps the app's layout: a header, a viewport that shows the selected step on a monitor, a panel beside it with the step's details, and a track of thumbnails along the bottom. What changes is what the track holds. The relay's app holds only the steps of one machine. The moved app holds one computer-use agent's whole timeline: its prompts, its messages and tool calls, the machine steps each call caused, and the results the agent received ([CU-08](../user-stories/computer-use.md#cu-08-review-what-the-agent-was-asked-said-and-did)).

- **User intent:** A maintainer wants to find where a run went wrong: in the prompt the parent wrote, in the agent's reasoning, in a tool call's arguments, or in the machine.
- **Entry conditions:** The agent's runs have ended and their relay machines are finished, so the machines' evidence exists. The maintainer has the run's local artifact directory.
- **User action:** The maintainer starts the viewer on the artifact directory and opens the address it prints, one per agent. The arrow keys move through the steps, and Space enlarges the selected picture. A reviewing agent reads the same timeline as data from the viewer's server.
- **Observable outcome:** The track starts with the prompt that spawned the agent. After it come the agent's messages and tool calls, in the order the session recorded them. Each tool call is followed by the machine steps that started while it ran, with their before and after snapshots, and then by the result the agent received. A later message from the parent starts the next run.
- **Feedback:**
  - The agent's steps and machine steps look different in the track and carry their kind in the panel: Prompt, Agent, Thinking, Tool call, Result, or the machine step's own kind.
  - A machine step's panel names the tool call that caused it, or says that no tool call asked for it, as for the checks after the agent's run.
  - A tool call's panel shows its arguments and lists the machine steps it caused.
  - A result's view shows the screenshot the agent received, when it received one.
  - The Overview names the agent, its model and session, how its machines were found, and each machine's verdicts, findings, outputs and files, as the relay's Overview did for one machine.
- **Failure and recovery:** A machine whose evidence is missing is named in the Overview, and the agent's side is still shown. The maintainer can reload the page once the evidence exists.

### 1.1 Page layout

```text
┌ Computer use agent_6deebbb0 · 149 steps 90 agent 59 machine ·········· Snapshots ✓  Execution ✓ ┐
│ [Trajectory] [Overview]                                                                         │
│ ┌──────────────── viewport ────────────────┐  ┌──────── panel ────────────────────────┐        │
│ │ 03  computer_observe { "app": "Reminders" }│  │ STEP 03 of 149                         │        │
│ │ ┌──────────────────────────────────────┐ │  │ Tool call · 15:01:18 UTC · Completed   │        │
│ │ │ TOOL CALL · COMPUTER_OBSERVE          │ │  │ Tool  computer_observe                 │        │
│ │ │ { "app": "Reminders" }                │ │  │ Arguments  { "app": "Reminders" }      │        │
│ │ └──────────────────────────────────────┘ │  │ Machine steps  Step 04 … Step 09       │        │
│ │ ‹        Tool call 15:01:18 UTC  Enlarge ›│  │ Result  Step 10 · after 1 min 27 s     │        │
│ └──────────────────────────────────────────┘  └────────────────────────────────────────┘        │
│ track: [01 Prompt][02 Agent][03 Tool call][04 machine ▣▣] … [09 machine ▣▣][10 Result ▣][11 Agent] … │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- The agent's steps and the machine steps are numbered together, in time order across the agent's runs. A machine step's panel shows "Asked for by" with its call, and its machine and relay step identifier.
- Long text, such as a prompt, a report or a tool call's arguments, is shown whole in the viewport and the panel.

## 2. Open points

- Where a person opens the page for a production run, as opposed to a test run, is not decided.
