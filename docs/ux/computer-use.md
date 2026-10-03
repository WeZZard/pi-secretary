# Computer-Use Subagent: Interaction Design

**Document type:** UX and interaction specification.

**Status:** Draft. Section 1 specifies the trajectory viewer that decisions [PS-D17 and PS-D18](../decisions.md) call for. No other computer-use interaction is specified here yet.

**Related documents:** [Requirements](../user-stories/computer-use.md), [technical design](../arch/computer-use.md), and the [subagent interaction design](subagents.md).

## 1. Trajectory viewer

The trajectory viewer is the relay's review app, moved into the computer-use extension ([PS-D18](../decisions.md)). It keeps the app's layout: a header, a viewport that shows the selected step on a monitor, a panel beside it with the step's details, and a track of thumbnails along the bottom. What changes is what the track holds. The relay's app holds only the steps of one machine. The moved app holds one computer-use agent's session: its prompts, its messages and tool calls, and the results it received. Each tool call is extended with what the computer-use extension recorded for it: the plan's steps, and the machine steps each plan step ran ([CU-08](../user-stories/computer-use.md#cu-08-review-what-the-agent-was-asked-said-and-did), [PS-D40](../decisions.md)).

- **User intent:** A maintainer wants to find where a run went wrong: in the prompt the parent wrote, in the agent's reasoning, in a tool call's arguments, in a decision the grounder or the permission guardian made, or in the machine. The maintainer also wants to see where the run's time went.
- **Entry conditions:** The agent's runs have ended and their relay machines are finished, so the machines' evidence exists. The maintainer has the run's local artifact directory.
- **User action:** The maintainer starts the viewer on the artifact directory and opens the address it prints, one per agent. The arrow keys move through the steps, and Space enlarges the selected picture. A reviewing agent reads the same trajectory as data from the viewer's server.
- **Observable outcome:** The track follows the session. It starts with the prompt that spawned the agent, and after it come the agent's messages and tool calls, in the order the session recorded them. A `computer_run_plan` call is followed by the plan's steps, in plan order. Each plan step is followed by the machine steps it ran, with their before and after snapshots. The result the agent received comes after the last plan step. A later message from the parent starts the next run.
- **Feedback:**
  - The track shows each kind differently, and the panel names the kind: Prompt, Agent, Thinking, Tool call, Plan step, Result, or the machine step's own kind.
  - A plan step's view shows its intent, its action, and what happened to it, as a sequence of phases with their durations:
    - the grounder's decision;
    - the permission guardian's judgement;
    - the wait for a person's approval, when one was asked, with its answer;
    - the input that was sent, or that nothing was sent.
  - Each thumbnail in the track has a line above it ([PS-D41, PS-D42](../decisions.md)): the step number in a step pill at the left, and the word Host or VM followed by an icon at the right. A robot icon marks a step the agent did in the host: a prompt, a message, a tool call, a result or a plan step. A virtual-machine icon, a monitor inside a dashed box, marks a machine step, which ran in the guest. The icon's tooltip names the host or the machine. The step pill is a smaller copy of the step pill in the monitor's heading. The icon is as tall as the step pill on the same line, and the line and the caption sit close to the thumbnail.
  - The caption under a thumbnail shows the step's status dot, the step's name, cut at its end when it is too long, and the time the step took at the right. A plan step that waited for approval shows that wait in this time.
  - The monitor's heading has the same parts: the step pill at the left, the step's name, cut at its end when it is too long, and the time the step took in the middle, and the word Host or VM with its icon at the right.
  - Between two thumbnails, a pill shows the interval from the first step's start to the second step's start. A plan step that waited for approval is followed by a pill that includes that wait, so a long wait stands out in the track. A step without a start time, such as a plan step that never ran, is passed over: the pill before it measures to the next step that has a start. A pill is left out after a step without a start time, and when the next start is earlier.
  - A plan step that sent nothing says why: the guardian held it for approval, the plan stopped before it, or a person declined it.
  - A plan step's panel shows the grounder's answers with their confidence, each guardian request with its answers, the verdict and its reason, and the approval's answer and wait. It links the call, and the machine steps the plan step ran.
  - A machine step's panel names the plan step that ran it, or the tool call whose observation read it.
  - A `computer_observe` call's panel shows the observation: the application, the window, the UI element count and how long the read took. It links the machine steps the read ran.
  - A result's view shows the screenshot the agent received, when it received one.
  - The Overview names the agent, its model and session, how its machines were found, and each machine's verdicts, findings, outputs and files, as the relay's Overview did for one machine. For each machine it also counts the machine steps that no plan step or observation asked for, such as the checks after the agent's run.
- **Failure and recovery:**
  - A machine whose evidence is missing is named in the Overview. The session's items and the plan steps are still shown, without pictures. The maintainer can reload the page once the evidence exists.
  - A tool call whose record is missing is shown as the session recorded it, and its panel says that no record was found.

### 1.1 Page layout

```text
┌─ Computer use agent_a7532e2d · 62 steps 21 agent 9 plan 32 machine · Snapshots ok  Execution ok ─┐
│ [Trajectory] [Overview]                                                                          │
│ ┌─ viewport ───────────────────────────────────┐  ┌─ panel ──────────────────────────────────┐   │
│ │ [41]  confirm_2 · key return 5 min 3 s  Host 🤖 │  │ STEP 41 of 62                            │   │
│ │ ┌──────────────────────────────────────────┐ │  │ Plan step · 16:45:27 UTC · Stopped       │   │
│ │ │ PLAN STEP · CONFIRM_2 · STOPPED          │ │  │ Intent  Press return to commit the       │   │
│ │ │ Press return to commit the second ...    │ │  │         second reminder.                 │   │
│ │ │ Grounder     outline 2 · D       0.4 s   │ │  │ Grounder  region outline 2 (1.00) ...    │   │
│ │ │ Guardian     ask                 4.5 s   │ │  │ Guardian  ask · guardian                 │   │
│ │ │ Approval     timed out       5 min 0 s   │ │  │   with text     change · local           │   │
│ │ │ Input        nothing was sent            │ │  │   without text  change · outside         │   │
│ │ └──────────────────────────────────────────┘ │  │ Approval  timed out · 5 min 0 s          │   │
│ │ <       Plan step 16:45:27 UTC     Enlarge > │  │ Call  Step 30 · Result  Step 42          │   │
│ └──────────────────────────────────────────────┘  └──────────────────────────────────────────┘   │
│ track: [30]     Host 🤖   [31]    Host 🤖   [32]          VM ⧈  ...   [41]    Host 🤖   ...      │
│        [Tool call]  1.2 s [Plan step] 0.4 s [before][after] ... 2.0 s [Plan step] 5 min 8 s ...  │
│        ● computer_ru…     ● new_note…  2.8 s ● cua.click   0.6 s       ● confirm_2… 5 min 3 s    │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- In the wireframe, 🤖 stands for the robot icon, ⧈ for the virtual-machine icon, `[41]` for a step pill and ● for a status dot. Each interval pill sits between the two thumbnails it measures.
- All items are numbered together, in the order of the track. A machine step's panel shows "Asked for by" with its plan step or call, and its machine and relay step identifier.
- Long text, such as a prompt, a report or a tool call's arguments, is shown whole in the viewport and the panel.

## 2. Open points

- Where a person opens the page for a production run, as opposed to a test run, is not decided.
