# vm-use Subagent: Interaction Design

**Document type:** UX and interaction specification.

**Status:** Draft. Section 1 specifies the trajectory viewer that decisions [PS-D17 and PS-D18](../decisions.md) call for, and Section 1.2 its click markers ([PS-D60](../decisions.md)). Section 2 specifies the approval dialog of the permission check mode `online` ([PS-D53](../decisions.md)).

**Related documents:** [Requirements](../user-stories/vm-use.md), [technical design](../arch/vm-use.md), and the [subagent interaction design](subagents.md).

## 1. Trajectory viewer

The trajectory viewer is the relay's review app, moved into the vm-use extension ([PS-D18](../decisions.md)). It keeps the app's layout: a header, a viewport that shows the selected step on a monitor, a panel beside it with the step's details, and a track of thumbnails along the bottom. What changes is what the track holds. The relay's app holds only the steps of one machine. The moved app holds one vm-use agent's session: its prompts, its messages and tool calls, and the results it received. Each tool call is extended with what the vm-use extension recorded for it: the plan's steps, and the machine steps each plan step ran ([VU-08](../user-stories/vm-use.md#vu-08-review-what-the-agent-was-asked-said-and-did), [PS-D40](../decisions.md)).

- **User intent:** A maintainer wants to find where a run went wrong: in the prompt the parent wrote, in the agent's reasoning, in a tool call's arguments, in a decision the grounder or the online plan check made, or in the machine. The maintainer also wants to see where the run's time went.
- **Entry conditions:** The agent's runs have ended and their relay machines are finished, so the machines' evidence exists. The maintainer has the run's local artifact directory.
- **User action:** The maintainer starts the viewer on the artifact directory and opens the address it prints, one per agent. The arrow keys move through the steps, and Space enlarges the selected picture. A reviewing agent reads the same trajectory as data from the viewer's server.
- **Observable outcome:** The track follows the session. It starts with the prompt that spawned the agent, and after it come the agent's messages and tool calls, in the order the session recorded them. A `vm_run_plan` call is followed by the plan's steps, in plan order. Each plan step is followed by the machine steps it ran, with their before and after snapshots. The result the agent received comes after the last plan step. A later message from the parent starts the next run.
- **Feedback:**
  - The track shows each kind differently, and the panel names the kind: Prompt, Agent, Thinking, Tool call, Plan step, Result, or the machine step's own kind.
  - A `vm_run_plan` call's view shows the plan check before the plan's steps, as a sequence of phases with their durations:
    - the online plan check, in the mode `online`, with its round trip;
    - the wait for a person's approval, when one was asked, with its answer.
  - A plan step's view shows its intent, its action, and what happened to it, as a sequence of phases with their durations:
    - the grounder's decision;
    - the input that was sent, or that nothing was sent.
  - Each thumbnail in the track has a line above it ([PS-D41, PS-D42](../decisions.md)): the step number in a step pill at the left, and the word Host or VM followed by an icon at the right. A robot icon marks a step the agent did in the host: a prompt, a message, a tool call, a result or a plan step. A virtual-machine icon, a monitor inside a dashed box, marks a machine step, which ran in the guest. The icon's tooltip names the host or the machine. The step pill is a smaller copy of the step pill in the monitor's heading. The icon is as tall as the step pill on the same line, and the line and the caption sit close to the thumbnail.
  - The caption under a thumbnail shows the step's status dot, the step's name, cut at its end when it is too long, and the time the step took at the right. A `vm_run_plan` call whose plan waited for approval shows that wait in this time.
  - The monitor's heading has the same parts: the step pill at the left, the step's name, cut at its end when it is too long, and the time the step took in the middle, and the word Host or VM with its icon at the right.
  - The caption's time is how long the step lasted ([PS-D44](../decisions.md)). A tool call lasts until its result, a plan step from its first activity, the read of the window or the grounder request, to its last judgement or machine step, and a machine step from its action to its after snapshot. A prompt, a message, a thinking item and a result take no time and show none.
  - Between two thumbnails, a pill shows the time before the second step started ([PS-D43, PS-D44](../decisions.md)). The pill measures from the end of the latest earlier step that the second step follows, or from the start of the step that contains it: a plan step's first machine step measures from the plan step's start, and a call's first plan step from the call's start. A wait for approval comes before the plan's first step, so it is part of the call's time in the call's caption, and of the pill before the call's first plan step. A step without a start time, such as a plan step that never ran, is passed over, and it has no pill before it. The pill's tooltip names the step it measures from and whether it measures from that step's start or end.
  - A plan step that sent nothing says why: the plan stopped before it, a person declined the plan, nobody could be asked, or nobody answered in time.
  - A plan step's panel shows the grounder's answers with their confidence and, in the mode `online`, the online plan check's two answers for the step, `reach` and `requested`, and whether the step needed approval and why. It links the call, and the machine steps the plan step ran.
  - A `vm_run_plan` call's panel shows the plan check: the mode and whether the delegated request or the configuration chose it ([PS-D54](../decisions.md)), the online API's round trip, the steps that needed approval with the reason for each, or that the check failed, and the approval's answer and wait.
  - A machine step's panel names the plan step that ran it, or the tool call whose observation read it.
  - A machine step that clicked shows a marker on its snapshots where the click landed, and the marker tells which mouse button pressed it ([Section 1.2](#12-click-markers), [PS-D60](../decisions.md)).
  - A `vm_observe` call's panel shows the observation: the application, the window, the UI element count and how long the read took. It links the machine steps the read ran.
  - A result's view shows the screenshot the agent received, when it received one.
  - The Overview names the agent, its model and session, how its machines were found, and each machine's verdicts, findings, outputs and files, as the relay's Overview did for one machine. For each machine it also counts the machine steps that no plan step or observation asked for, such as the checks after the agent's run.
- **Failure and recovery:**
  - A machine whose evidence is missing is named in the Overview. The session's items and the plan steps are still shown, without pictures. The maintainer can reload the page once the evidence exists.
  - A tool call whose record is missing is shown as the session recorded it, and its panel says that no record was found.

### 1.1 Page layout

```text
┌─ vm-use agent_a7532e2d · 62 steps 21 agent 9 plan 32 machine · Snapshots ok  Execution ok ─┐
│ [Trajectory] [Overview]                                                                          │
│ ┌─ viewport ───────────────────────────────────┐  ┌─ panel ──────────────────────────────────┐   │
│ │ [30]  vm_run_plan · 52.6 s              Host 🤖 │  │ STEP 30 of 62                            │   │
│ │ ┌──────────────────────────────────────────┐ │  │ Tool call · 16:44:31 UTC · Completed     │   │
│ │ │ TOOL CALL · VM_RUN_PLAN · COMPLETED      │ │  │ Goal  Add two reminders and share        │   │
│ │ │ Add two reminders and share the list.    │ │  │       the list.                          │   │
│ │ │ Plan check   online             1.8 s    │ │  │ Check  online · 1.8 s                    │   │
│ │ │ Approval     approved          41.0 s    │ │  │   share_1  outside_guest · no            │   │
│ │ │ Steps        11 plan steps               │ │  │            leaves the guest              │   │
│ │ │                                          │ │  │ Approval  approved · 41.0 s              │   │
│ │ └──────────────────────────────────────────┘ │  │ Steps  31 to 41                          │   │
│ │ <       Tool call 16:44:31 UTC     Enlarge > │  │ Result  Step 42                          │   │
│ └──────────────────────────────────────────────┘  └──────────────────────────────────────────┘   │
│ track: [30]     Host 🤖   [31]    Host 🤖   [32]          VM ⧈  ...   [41]    Host 🤖   ...      │
│        [Tool call] 43.0 s [Plan step] 2.4 s [before][after] ... 2.0 s [Plan step] 0.6 s     ...  │
│        ● vm_run_pl… 52.6 s ● new_note…  2.8 s ● cua.click   0.6 s       ● confirm_2…  0.9 s      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- In the wireframe, 🤖 stands for the robot icon, ⧈ for the virtual-machine icon, `[30]` for a step pill and ● for a status dot. Each interval pill sits between the two thumbnails it measures.
- The selected step is a `vm_run_plan` call in the mode `online`. The online plan check marked the step `share_1`, whose effect leaves the guest, and a person approved the plan after 41.0 s. The call's caption and the pill before its first plan step include that wait.
- All items are numbered together, in the order of the track. A machine step's panel shows "Asked for by" with its plan step or call, and its machine and relay step identifier.
- Long text, such as a prompt, a report or a tool call's arguments, is shown whole in the viewport and the panel.

### 1.2 Click markers

Decision [PS-D60](../decisions.md): a machine step's snapshots show where the step clicked and with which mouse button.

- **User intent:** A maintainer wants to see what a click hit without reading coordinates, and to tell a right click that opened a context menu from a left click that pressed a button.
- **Entry conditions:** The selected item is a machine step that sent a click or acted on a UI element, and its snapshots exist.
- **User action:** The maintainer selects the step, or enlarges its snapshot with Space. The key M hides and shows the markers, so a marker never keeps the maintainer from seeing what lies under it.
- **Observable outcome:** The before snapshot shows a solid marker centred on the point the click landed. The after snapshot shows the same marker as an outline, so what changed under it stays visible. The marker is drawn in the monitor, in the enlarged picture and, as a dot in the button's colour, on the step's thumbnails.
- **Feedback:**
  - Each mouse button has its own marker, told apart by the letter in it as well as by its colour, so the marker reads without colour:

    | Input | Marker | Colour |
    | --- | --- | --- |
    | Left click | A ring with `L` | Blue |
    | Right click | A ring with `R` | Orange |
    | Middle click | A ring with `M` | Purple |
    | Double click | Two rings with the button's letter and `×2`, such as `L×2` | The button's colour |
    | Click with modifier keys | The keys before the letter, such as `⌘ L` | The button's colour |

  - A small dot at the ring's centre marks the exact point.
  - The marker's tooltip names the input, the point in screen points and in snapshot pixels, and whether the point was given or taken from a UI element's centre, for example "Right click at (773, 455) points, pixel (1546, 910), at the centre of Button "Done"".
  - The panel shows the same in a row named Pointer.
  - An accessibility action on a UI element, such as a press, showing its context menu or setting its value, presses no mouse button. It is shown as a dashed box around the UI element, labelled with the action, such as `AX show menu`, and never as a right click.
  - A step that sent no click and acted on no UI element, such as a key press, has no marker.
- **Failure and recovery:**
  - A step whose position was not recorded shows no marker, and its Pointer row says "Position not recorded". The viewer never guesses a position.
  - A point that lies outside the snapshot shows no marker, and the Pointer row gives the point and says it is outside the snapshot.
  - A step whose snapshots are missing shows its Pointer row without a picture.

```text
┌─ viewport ────────────────────────────────────────────┐  ┌─ panel ─────────────────────────────┐
│ [194]  cua.click · 2.3 s                        VM ⧈  │  │ STEP 194 of 200                      │
│ ┌───────────────────────────────────────────────────┐ │  │ ...                                  │
│ │   ┌ Open ───────────────────────────┐             │ │  │ Pointer  Left click                  │
│ │   │ Applications   Calculator ◉L    │             │ │  │          (773, 455) points           │
│ │   │                                 │             │ │  │          pixel (1546, 910)           │
│ │   │              [Cancel] [Open]    │             │ │  │          given by the command        │
│ │   └─────────────────────────────────┘             │ │  │                                      │
│ └───────────────────────────────────────────────────┘ │  │                                      │
│ <     BEFORE 06:56:20.819   Markers (M)     Enlarge > │  │                                      │
└───────────────────────────────────────────────────────┘  └──────────────────────────────────────┘
```

- In the wireframe, ◉L stands for the solid ring with the letter `L` of a left click on the before snapshot. The monitor's chin has a Markers switch that the key M also turns.

## 2. Approval dialog

In the mode `online`, the online plan check marks the steps of a plan that need a person's approval ([technical design §8.3](../arch/vm-use.md#83-online-plan-check)). When it marks at least one step, the executor asks the person once for the whole plan, before the plan's first step ([technical design §8.4](../arch/vm-use.md#84-approval-by-a-person), [PS-D53](../decisions.md)).

- **User intent:** The person wants to decide whether the plan may run, from what its steps will do, before anything is sent to the machine.
- **Entry conditions:** The permission check mode is `online`, and the online plan check marked at least one step of the plan. A failed check marks every step. The main Pi session that delegated the task has an interface.
- **User action:** The person reads the dialog in the main session and chooses Yes to approve the plan or No to decline it.
- **Observable outcome:**
  - Yes runs the whole plan to its end, or to its first escalation, without asking again. A later plan is checked and asked about again.
  - No ends the plan with `approval_denied`. Nothing in the plan is sent, and the agent reports that the person declined.
- **Feedback:**
  - The dialog's title is "vm-use needs approval".
  - The dialog lists the application and the window first.
  - The dialog then lists each step that needs approval. Each entry shows the step's action and UI element, or its keys, the text it types when it types any, the agent's words for the step, and why it needs approval:
    - its effect leaves the guest;
    - the delegated task asks for approval before this kind of step;
    - the online plan check failed or gave no usable answer.
  - The plan's goal comes last, because the agent's words describe what it intends, not what the steps do.
  - The last line says that approving runs the whole plan without stopping, that declining stops it, and how long the dialog waits for an answer.
  - Steps that do not need approval are not listed. They run with the approved plan.
- **Failure and recovery:**
  - When the session has no interface, such as in print mode, RPC or a benchmark, nobody is asked. The plan ends with `approval_required`, and nothing in the plan is sent.
  - When nobody answers within the approval time limit, which is provisionally 5 minutes, the dialog closes, the plan ends with `approval_required`, and nothing in the plan is sent.
  - When the run is cancelled while the dialog is open, the dialog closes and nothing in the plan is sent.
  - The parent agent cannot answer the dialog. Only the person at the main session's interface can.

### 2.1 Dialog layout

```text
┌─ vm-use needs approval ──────────────────────────────────────────────┐
│ Application: Reminders                                               │
│ Window: Groceries                                                    │
│ This step needs approval:                                            │
│ - share_1: click Button "Share"                                      │
│   The agent's step: Share the Groceries list with Alex.              │
│   Why: its effect leaves the virtual machine.                        │
│ The agent's goal: Add two reminders and share the list with Alex.    │
│                                                                      │
│ Approving runs the whole plan without stopping. Declining stops it.  │
│ Without an answer in 5 min, the plan stops and nothing is sent.      │
│                                                                      │
│ → Yes                                                                │
│   No                                                                 │
└──────────────────────────────────────────────────────────────────────┘
```

- In the wireframe, → marks the selected choice.
- A step that types text shows a line "Text to type:" with the text, under its action.
- When several steps need approval, the heading reads "These steps need approval:", and each step has its own entry. Long lists end with a line that counts the steps not shown.

## 3. Open points

- Where a person opens the page for a production run, as opposed to a test run, is not decided.
