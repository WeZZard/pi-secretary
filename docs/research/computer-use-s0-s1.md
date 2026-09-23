# Computer-Use Subagent: Planner and Executor Investigation

**Document type:** Research record.

**Status:** Recorded evidence from a design investigation on 2026-09-22. Sections 8 and 9 add observations from implementing Phases 1 to 4 on 2026-09-23. This record does not describe current Secretary behavior, and it does not approve any requirement. The [technical design](../arch/computer-use.md) cites this record as the evidence for its decisions.

**Related documents:** [Computer-use technical design](../arch/computer-use.md), [subagent architecture](../arch/subagents.md), and [documentation responsibilities](../README.md).

## 1. Scope

- This investigation evaluated a computer-use subagent with two model tiers. A large planner model (System 0) plans once per task, and a small structured-decision model (System 1) makes one local decision per step.
- The planner candidate is Qwen 3.8 27B. The executor candidate is DiffusionGemma 26B-A4B served behind a Jev-compatible structured-decision interface.
- The harness, which is ordinary code, owns memory, routing, execution and verification in the design under test.
- Every experiment tested selection among supplied candidates. No experiment tested whether the correct candidate was supplied. [Section 7](#7-verification-limits) explains why this is the largest limitation.
- No service was modified during the investigation, and no probe ran against a production desktop session.

## 2. Target infrastructure

All facts in this section were read from the running services on 2026-09-22, not from deployment notes.

### 2.1 Planner: Qwen 3.8 27B

- One SGLang server runs with tensor parallelism across both DGX Spark nodes. It is launched with `--tp-size 2 --nnodes 2`, and rank 0 runs on `spark-left`.
- The server binds `127.0.0.1:8000`. A Caddy reverse proxy on `192.168.50.199:8080` exposes it behind a bearer token.
- The LiteLLM gateway publishes the model as `qwen3.8-27b`.
- The context window is 262,144 tokens, and the output limit is 131,072 tokens.
- The server runs the `qwen3` reasoning parser and the `qwen3_coder` tool-call parser. It uses DFLASH speculative decoding with 8 draft tokens.
- The model accepts images. The gateway declares `supports_vision: true`, which contradicts an earlier note in the deployment kit. A 128×128 four-quadrant PNG sent through the gateway returned `Red` for the top-left quadrant, which is correct.

### 2.2 Executor: DiffusionGemma 26B-A4B behind the Jev interface

- Each DGX Spark node runs one `djev-spark:latest` container.
- Inside each container, vLLM serves plain generation on port 8010. A Jev-compatible structured server serves `POST /v1/systemone` on port 8011.
- The containers run with `CANVAS=128`, `MAX_MODEL_LEN=4096`, `MAX_SEQS=8`, `KV_CACHE_GB=3` and `GPU_UTIL=0.35`.

### 2.3 Load balancing

There are two separate paths, and they must not be confused.

- The plain-generation path is the `dgemma` model on the LiteLLM gateway. It is two entries with the same name, one for port 8010 on each node, which is how LiteLLM spreads load.
- The structured-decision path is `http://jev.home.arpa/`. The gateway host's Caddy forwards it to `127.0.0.1:8012`. A second Caddy in the `~/bin/jev-lb` container balances with the `least_conn` policy across `192.168.50.199:8011` and `192.168.50.200:8011`. It performs `/health` checks and serves `/llms.txt` as the client-facing contract.

### 2.4 The 26-alternative limit

- The limit is a constant in the deployed fork, not a model property.
- In the `mmastrac/djev-spark` checkout at revision `1444f3e`, `server/structured_server.py:148` rejects any question with more than 26 alternatives.
- Option labels are generated as `chr(ord("A") + i)`. The label set is therefore the 26 single letters, and a 27th option would produce `[`.
- The source sets `CANVAS_LEN = 64`, while the deployment runs with `CANVAS=128`.
- Hosted Jev documents a limit of 255 alternatives for a choice question. The local deployment is therefore more constrained.

## 3. Measurement method

The following definitions apply to every number in this record.

- **Round-trip latency, median (ms):** Each request is timed on the client from sending the request to receiving the full response. The client is the Mac, and requests go to `http://jev.home.arpa`, so the balancer hop is included. The reported value is the median across the trials in a cell.
- **Input tokens, median:** The value is the service's own `usage.input_tokens`, reported as the median across the trials in a cell.
- **Top-1 accuracy:** A trial is correct only when the highest-ranked label equals the expected label.
- **Confidence, median:** The value is the service's reported confidence for the chosen label, reported as the median across the trials in a cell.
- Every request pins `samples` to 1, so each stage is exactly one read.
- These figures are not comparable with the single-node figures published in the service's `/llms.txt`. Those figures were measured without a balancer in the path. They are also not comparable with any third-party figure.
- Sample sizes are small and are stated per experiment. A difference of two or three trials is not an established difference.

## 4. Recorded measurements

### 4.1 Candidate list length (n = 8 per cell)

Four near-miss distractors were held constant in every cell.

| Candidates | Top-1 accuracy | Round-trip latency, median | Confidence, median | Input tokens, median |
| --- | --- | --- | --- | --- |
| 5 | 7/8 | 155 ms | 0.84 | 263 |
| 10 | 7/8 | 128 ms | 0.80 | 424 |
| 16 | 8/8 | 201 ms | 0.98 | 624 |
| 22 | 8/8 | 207 ms | 0.99 | 824 |
| 25 | 8/8 | 192 ms | 1.00 | 924 |
| 26 | 8/8 | 212 ms | 0.96 | 959 |

- Accuracy did not collapse at any length up to the limit.
- The only hard failure was input validation. A question with 26 alternatives returned HTTP 200, and a question with 27 returned HTTP 422.
- A 26-candidate list with realistic descriptors cost 1,785 input tokens. Each descriptor carried role, label, value, enabled state, focus state and bounds. The context window is therefore not the binding constraint at the limit.
- **Recorded defect:** The distractor count was held constant, but the distractor proportion was not. Longer lists therefore had a lower density of hard distractors. This experiment does not separate list length from distractor difficulty. It supports only two claims: accuracy did not collapse, and the failure at 27 was a validation rejection.

### 4.2 Question coupling on a list of buttons (n = 12)

| Arrangement | Top-1 accuracy | Round-trip latency, median |
| --- | --- | --- |
| Both questions in one stage | 12/12 | 173 ms |
| Operation question staged with `depends_on` | 9/12 | 329 ms |
| Operation question marked `alone` in its own pass | 9/12 | 220 ms |

### 4.3 Question coupling on a mixed-role list of 26 candidates (n = 48)

The experiment used six goals across eight random seeds.

| Arrangement | Element correct | Operation correct | Both correct | Round-trip latency, median | Input tokens, median |
| --- | --- | --- | --- | --- | --- |
| Both questions in one stage | 48/48 | 48/48 | 48/48 | 256 ms | 990 |
| Operation question staged with `depends_on` | 43/48 | 47/48 | 43/48 | 397 ms | 996 |
| Operation question marked `alone` in its own pass | 46/48 | 47/48 | 45/48 | 359 ms | 947 |

- Staging the operation question after the element question reduced accuracy.
- Staging also increased median latency by roughly 55 percent.
- Staging produced five element errors that the single-stage form did not produce.
- The supported shape is several separate questions in one request, answered in one stage.

### 4.4 Companion questions (n = 12)

| Arrangement | Top-1 accuracy | Round-trip latency, median | Confidence, median |
| --- | --- | --- | --- |
| Element question only | 9/12 | 168 ms | 0.84 |
| Element question and a related operation question | 12/12 | 179 ms | 0.99 |
| Element question and an unrelated progress question | 12/12 | 170 ms | 1.00 |

Adding a companion question to the same request did not measurably increase latency.

### 4.5 Name-only labels compared with verbose descriptors (n = 8, 26 candidates)

| Encoding | Top-1 accuracy | Input tokens, median | Round-trip latency, median |
| --- | --- | --- | --- |
| Verbose descriptors with role and state | 8/8 | 435.5 | 395 ms |
| Name-only labels without role or kind | 8/8 | 349.5 | 341 ms |

- The sample does not separate the two encodings by accuracy.
- The name-only encoding used about 20 percent fewer input tokens.
- The name-only encoding dropped role and kind without a measurable accuracy penalty at this sample size.

### 4.6 Cost of a name-only element list as it grows

The share is computed against the executor's 4,096-token model length.

| Elements | Input tokens | Share of the 4,096-token model length |
| --- | --- | --- |
| 26 | 350 | 9% |
| 52 | 506 | 12% |
| 100 | 794 | 19% |
| 200 | 1,494 | 36% |
| 240 | 1,774 | 43% |

- The marginal cost is roughly seven tokens per element.
- A full window's controls fit in the request and still leave room for the plan step, the recent actions and the answer.
- This result overturns the earlier assumption that retrieval down to a shortlist was mandatory before every step.

### 4.7 Merging independent heads by confidence (n = 8)

- 52 candidates were split across two independent questions of 26 each. The harness took the answer from whichever question reported the higher confidence.
- This scored 6/8.
- One failure returned a confidence of 0.99 on a wrong answer while the question holding the correct answer reported a lower confidence.
- Confidences from independent questions are not comparable. They must not be used to choose between questions.

### 4.8 A routing question with one speculative question per group (n = 12)

One request carried a routing question over four groups and one speculative element question per group. The groups were toolbar, sidebar, content and context menu, and they covered 103 candidates. Code selected the element answer from the group that the routing question chose.

| Measure | Result |
| --- | --- |
| Routing question correct | 12/12 |
| Element correct when routed | 12/12 |
| End-to-end correct | 12/12 |
| Input tokens | 1,301, which is 32 percent of the 4,096-token model length |
| Round-trip latency, median | 526 ms |

- Capacity becomes 26 multiplied by the number of groups, and no confidence comparison is involved.
- The name `New Folder` appeared in two groups at once. The routing question still chose the correct group in 12 of 12 trials. The group level therefore recovers some of the disambiguation that the name-only encoding gives up.

## 5. Findings

- Asking every needed question in one request, in one stage, is faster and more accurate than staging questions.
- Confidence is not an error detector. In the list-length experiment, the two wrong answers carried a confidence of 0.77, while several correct answers carried confidences between 0.51 and 0.67.
- Confidence is usable as a safety gate and as a routing hint. Error detection belongs to structural signals and to postconditions computed by code.
- A routing question with speculative per-group questions removes the practical effect of the 26-alternative limit without changing the service.
- The economic case for the executor is not token savings. The executor spends more tokens per decision than the planner would. The benefit is that each per-step decision stays out of the planner's conversation.

## 6. Prior art consulted

These sources were read but not verified here. None of their figures is comparable with the measurements above.

- **TypeSafe speculative fan-out pattern:** It puts every question the system might need, including speculative ones, into a single call, and code decides relevance afterward.
- **Browser Use `jev-ultrafast`:** It resolves an operation and a target in one round trip with one speculative target question per operation. It filters each target question to compatible elements, and it calls a small language model only for typed text.
- **`lahfir/agent-desktop`:** It drives macOS through accessibility trees. A language model holds memory and context while Jev selects the control, and the tree is never placed in the language model's context.
- **`awlevin/typesafe-computer-use`:** It combines optical character recognition, the accessibility tree and computed context. It keeps the action and the target as separate questions. It stops on a confidence below 0.4, on two consecutive actions with no effect, or at 100 steps. It presses accessibility elements rather than clicking coordinates. An open issue in that project reports that similar link names split the vote.
- **Cua `jev-use`:** It documents a typed escalation contract. Its reasons distinguish a task that needs generated text, a state too large to judge, genuine uncertainty that still returns the answer as a prior, and an unreachable backend. Its chooser also offers reserved `reobserve` and `abstain` choices.
- **Cua `CUA-S1-FORMS`:** It is an MIT-licensed specialist model with 706,048 parameters trained on Jev's contract. Its authors report 99.7 percent against 83.6 percent for hosted Jev overall. On steps that needed judgment, the two scored 100 and 96 percent. The whole gap sat on steps where the correct action was no action, at 100 against 74 percent. The lesson is that conventions such as "do nothing when the step is already satisfied" must be stated or trained, not assumed. Its training data used forced pairs of look-alike distractors, which is the only known countermeasure to the near-miss confusion also observed here.

## 7. Verification limits

- Everything in [Section 4](#4-recorded-measurements) was executed against the live services on 2026-09-22.
- The probe scripts are kept outside version control, beside the investigation handoff in the `pi-secretary` main checkout at `.handoff/s0-s1-probe/`. Each script prints the measurement formula it uses. A clean clone of this repository cannot reproduce the measurements until the scripts are added to version control.
- Sample sizes are 8, 12 or 48 depending on the experiment. The small differences between cells are not statistically established.
- The list-length experiment confounds length with near-miss density, as recorded in [Section 4.1](#41-candidate-list-length-n--8-per-cell).
- Every experiment tested selection among supplied candidates. None tested whether the correct candidate was present. The retrieval step must therefore record the full tree, the reduced list and every discard reason from the first day. A wrong answer can then be attributed to retrieval or to judgment.
- A 96×96 test image was billed at 64 image tokens. The cost of a real screenshot at panel resolution has not been measured.
- This record does not establish that the design works end to end. No acceptance scenario has run against a real computer-use target.

## 8. Phase 1 observations (2026-09-23)

These observations come from implementing Phase 1 of the plan. They were taken on the development Mac with `cua-driver` 0.12.6, against a disposable TextEdit document opened in the background. They are not comparable with the executor measurements in Section 4.

### 8.1 Accessibility tree facts

- A tree-only `get_window_state` read of the TextEdit window returned 364 elements. 319 of them were menu items of closed menus, and those items had no frames.
- The first read after a background launch lacked the window element entirely. A read taken seconds later included it.
- The three title-bar buttons had no label and no value, so a name-only table cannot include them.
- The text area's label was the whole document text.
- TextEdit's menu-bar items at first had no frames. A later read, with TextEdit still not active, reported frames at the top of the screen, where the active application's menu bar was drawn.
- The background launch raised TextEdit's window above the active application's window without activating TextEdit. Window stacking order therefore does not identify the application that owns the menu bar.
- A visible window was briefly reported with `is_on_screen` set to `false` in three consecutive reads, and then reported as on screen again. The cause was not identified.

### 8.2 Observation read time

**Formula:** The value is the backend-side wall-clock time of one `readWindow` call. It runs from the first driver call to the parsed result, and it includes `list_windows`, `list_apps` and `get_window_state`. The client is the local backend on the development Mac, and the value is the median over the samples.

| Read | Samples | Observation read time, median |
| --- | --- | --- |
| Tree only | 5 | 1,291 ms |
| With screenshot | 1 | 1,108 ms |

- A single `list_apps` call took about one second on its own when timed with the shell, so it dominates the read time.
- A single tree-only `get_window_state` call took 0.26 seconds of shell wall-clock time, which is a different formula and is stated here only to locate the cost.

### 8.3 Screenshot input tokens on the planner

**Formula:** Image input tokens equal the gateway's `usage.prompt_tokens` for a request with the image and a fixed text, minus the same value for the identical request without the image. The model was `qwen3.8-27b` through the LiteLLM gateway. Each variant was sent twice, and both counts were identical.

| Screenshot size in pixels | Image input tokens |
| --- | --- |
| 1312×844, the window at native Retina scale | 1,068 |
| 656×422 | 262 |
| 328×211 | 72 |

- The cost is close to one token per 32×32-pixel patch, so it scales with pixel area.
- A full Retina screen would cost more than ten thousand tokens by the same proportion. That extrapolation was not measured.
- The script is `scripts/computer-use/measure-image-tokens.ts`, and it prints its formula.

## 9. Phase 2 to 4 observations (2026-09-23)

These observations come from recording real accessibility trees and replaying them against the live executor. The windows were a disposable TextEdit document and its Open dialog, Calculator, a Finder window on a folder of 40 dummy files, and a local Safari test page with look-alike links. The development Mac ran `cua-driver` 0.12.6. The recording and evaluation scripts are `scripts/computer-use/record-trees.ts` and `scripts/computer-use/evaluate-decisions.ts`, and both print their formulas.

### 9.1 Tree facts

- The structured `elements` array holds only indexed elements. In Finder and in the Open dialog, the names of sidebar rows, such as "Downloads", exist only as unindexed static text in the Markdown rendering. The observer now takes those names from the Markdown, but this was verified only against recorded Markdown, because the windows were unavailable for a live re-read.
- Safari's first read of the test page had no web area at all. The second read had all 28 links and the form controls.
- In Safari, more than 90 percent of the walked nodes were closed-menu items, mostly from the History and Bookmarks menus. The menu bar is walked first, so large menus can consume the node cap before the window content.
- Calculator in programmer mode exposed 106 buttons as direct children of the window, with no containers.
- The title-bar buttons of every window had no label, value or descendant text.
- Finder's Back button was named `back` and was disabled, because the folder had no history.
- While these checks ran, every window, including other applications' windows, was reported off screen twice for minutes at a time. This is consistent with a Space switch or a locked screen. Live re-recording and the Phase 3 live check could not run during those periods on the development Mac. Both were later run as standalone scripts in a relay virtual machine, as [Section 10](#10-standalone-script-checks-in-a-macos-virtual-machine-2026-09-23) records.

### 9.2 Retrieval on recorded trees

19 step intents were labelled with their correct element before any tree was inspected. One more intent, creating a folder in the Open dialog, was withdrawn because that dialog has no such control.

| Cause | Intents | Assessment |
| --- | --- | --- |
| The target was below the visible part of Finder's list. | 2 | The exclusion is correct. A scroll is needed first. |
| The target was only a menu item of a closed menu. | 1 | The exclusion is correct. A menu or shortcut step is needed. |
| The target was disabled. | 1 | The exclusion is correct. |
| The target was an unnamed title-bar button. | 1 | This is a real gap. |
| The target's name was only in the Markdown. | 1 | This is fixed in code and verified on recorded Markdown only. |

**Retrieval miss rate:** 6 of 19 labelled intents had their target absent from the executor's table.

### 9.3 Executor decisions on recorded trees

**Formulas:** Each labelled intent was sent as one request per seed, with seeds 1, 2 and 3, so each run has 57 decisions.

- A correct action means the policy acted on an expected element.
- A judgment miss means the expected element was in the table and the policy acted on another element. Its rate is over the 39 decisions whose element was in the table.
- A wrong action on an unlisted target means the expected element was absent and the policy acted anyway. Its rate is over the 18 decisions whose element was absent.
- Executor round-trip latency, median (ms), is the harness-side time from sending the request to the full response.

The first two runs grouped by 26 elements, before the `none` option existed. The last two grouped by 25 elements and included the hidden-item note in region descriptions.

| Run | Correct actions | Judgment misses | Wrong actions on unlisted targets | Escalations | Round-trip latency, median |
| --- | --- | --- | --- | --- | --- |
| Plain region names, 26 per group | 22 of 57 | 11 of 39 | not recorded | 10 | 175 ms |
| Region descriptions with member names, 26 per group | 34 of 57 | 0 of 39 | not recorded | 8 | 187 ms |
| Member names, 25 per group, no `none` | 35 of 57 | 0 of 39 | 16 of 18 | 6 | 190 ms |
| Member names, 25 per group, with `none` | 33 of 57 | 0 of 39 | 7 of 18 | 17 | 193 ms |

- Every judgment miss with plain region names occurred in windows split into meaningless parts, which were Calculator and the Safari page. In an earlier single-seed run with plain region names, seed 42, the five wrong answers carried element confidences between 0.80 and 0.98, so the confidence gate could not catch them.
- Member-name descriptions raised the input tokens reported by the service. On Calculator they rose from 1,950 to 2,480, which is 61 percent of the executor's 4,096-token model length.
- Adding `none` to every element question adds a 27th alternative to a full 26-element group. The service rejected those requests with HTTP 422 until groups were capped at 25.
- With `none`, three of the seven remaining wrong actions on unlisted targets chose a plausible path. Finder's Action menu contains New Folder, and the Open dialog's "Where:" menu leads to folders. The three "close the document window" decisions clicked the text area, because the close button has no name.
- The executor never chose to scroll when the target was below the visible part of a list, in 18 of 18 decisions, even when the request stated how many items were hidden.
- The executor judged "Submit the form" and "Sign out of every device" destructive in some seeds, which produced `approval_required` escalations with the correct element as the prior.
- These results come from 19 intents on five windows. They show the direction of each change but do not establish rates for other applications.

## 10. Standalone script checks in a macOS virtual machine (2026-09-23)

These checks ran the Phase 2, Phase 3 and Phase 5 scripts under Node.js inside a disposable macOS 26 virtual machine. Claude Code leased the machine and started the scripts through the `mcp-vm-relay` plugin. The guest ran `cua-driver` through the local driver backend.

**Scope:** Pi did not run in these checks, so they are not live checks of the Pi extension.

- The staged copy replaced Pi's package, `@earendil-works/pi-coding-agent`, with a stub.
- The scripts called the harness function `executeRunPlan` directly, which is the function that the `computer_run_plan` tool calls.
- The plans were written by hand, so the planner model was not tested.
- Pi's extension loading, tool registration, tool-call input from the planner, cancellation signal and session hooks were not tested.
- The results are therefore evidence for the harness modules and for `cua-driver` behavior in the guest. They are not evidence for the Pi infrastructure. The fix plan requires the same checks to be repeated with Pi running the extension. Every action used real pointer or keyboard input, as owner decision D3 requires. The test content was a scratch TextEdit document, Calculator, a Finder window on a folder of 40 dummy files, and a local Safari test page. Safari stayed in front, so TextEdit, Calculator and Finder were partly or fully covered during every action.

**Formulas:**

- **Step time (ms)** is wall clock from the first action of a step to the evaluated postcondition, including the verifying observation. The scripted-plan script prints this formula with its table.
- **Executor round-trip latency (ms)** is the harness-side time from sending the request to receiving the full response. This is the formula of [Section 9.3](#93-executor-decisions-on-recorded-trees), but the client here is the guest virtual machine rather than the development Mac. The two sets of values were measured under different network paths and are not compared.
- **Input tokens** are the values that the executor service reported in `usage.input_tokens`.

The run directories are under the ignored `relay-evidence/relay-computer-use-live-check-89d2966b/` directory. The relay manifest records the whole session as failed, because several intermediate runs exited with an error before the fixes below. Human review of the relay evidence is pending.

### 10.1 Tree recording

- The guest recorded all four windows through the local backend. No read was truncated.
- The labelled retrieval check missed 4 of 16 intents. Every miss had a known cause. The close button exists only as a closed-menu item, Finder's Back button is disabled, the file "Report Q4" is not in the folder, and New Folder is reachable only through a closed menu.

### 10.2 Real input into covered windows

| Check | Steps verified | Result |
| --- | --- | --- |
| Type 19 characters into the TextEdit document | 1 of 1 | All 19 characters arrived through real key presses. The step time was 24,964 ms. |
| Clear Calculator, then compute 7 plus 3 | 6 of 6 | The window's descendant text read "7+3 10" at the end. |
| Scroll Finder's file list to the top, down two pages and up two pages | 6 of 6 | The last row appeared after the second page, and the first file returned after scrolling up. |

- The TextEdit text arrived at the start of the document, although the step clicked the center of the text area first. The click, posted to the covered window's process, did not move the insertion point. A step that relies on a click to place the insertion point is therefore not reliable in a covered window.
- Calculator's display is not an element. Its text exists only as descendant text of the window, and each number is preceded by a Unicode left-to-right mark.
- Calculator's clear button is named "All Clear" when the display is empty and "Clear" otherwise, so the scripted check cleared the display with the Escape key instead.

### 10.3 Defects found and fixed

Each defect below made a check fail although the action had worked. Each fix has a unit test, and each check was run again after its fix.

- **`changed` ignored descendant text.** Pressing "3" in Calculator changed only the display, so the visible signature did not change. The signature now includes descendant text.
- **Names kept bidirectional marks.** The marks prevented a match on the display text. Names and compared text now drop them.
- **No predicate could find text inside a larger text.** After Equals, the window's descendant text was "7+3 10", and no element was named "10". The new `text { contains }` predicate searches values and descendant text.
- **`text` first searched labels too.** In the first live harness run, `text contains "7"` held before anything was pressed, because the button labelled "7" matched. The step was skipped by the precheck. Labels are no longer searched, because they name controls rather than show content.
- **A group's frame could lie outside the window.** Finder's icon-view list reported a container frame 804 points tall inside a 436-point window, so the scroll point at its center fell outside the window. A group's frame is now clipped to the window.
- **A page scroll moved much less than a page.** One page-sized wheel notch moved Finder's list by 100 points. The local backend now sends enough notches to move about 80 percent of the scrolled region's height.
- **The verifier counted elements scrolled out of the window.** After a scroll, Finder still reported the first file 140 points above the window, and `absent` failed. The verifier now uses the observer's rule that an element's center must lie inside the window unless it belongs to a menu.

### 10.4 The harness function with the live executor, without Pi

`scripts/computer-use/run-plan-live.ts` ran `computer_run_plan` inputs through the real harness, the local backend and the live executor at `http://jev.home.arpa`. Pi did not run, and the planner was not involved, because the plans were written by hand.

| Plan | Outcome | Executor decisions | Round-trip latency, per decision | Input tokens, per decision |
| --- | --- | --- | --- | --- |
| Calculator: press 7, Add, 3 and Equals | completed, 4 of 4 steps verified | 4 | 176, 230, 193 and 217 ms | 591 to 641 |
| Finder: scroll the list down twice | completed, 2 of 2 steps verified | 2 | 607 and 365 ms | 1,365 and 1,423 |

- In Calculator, the window has 22 kept elements and forms one group, so no routing question was asked. The executor chose the expected button in every step. The lowest element confidence was 0.79, for the 7 button.
- In Finder, the executor answered the routing question with the list region at confidence 1.0 and chose `scroll_down` at confidence 1.0 in both steps. It answered `none` to every element question, which is correct for a scroll.
- The first Calculator attempt skipped every step, because every postcondition already held on the stale display "7+3 10". The precheck works as designed, but a plan whose postconditions are already true before their steps does nothing. The postconditions must describe a change that the step causes.
- The second attempt escalated `postcondition_failed` at the Add step, because the 7 step had been skipped by the label match described in Section 10.3. The escalation carried the executor's prior and the current table, as the escalation contract requires.

### 10.5 Verification limits

- These checks used standalone scripts and hand-written plans. Pi, the planner model, the Pi tool call and the relay backend were not part of the loop.
- The screenshots in the relay evidence show the desktop, where Safari covered the other windows. They do not show Calculator's display or Finder's list, so the accessibility tree is the only evidence for those results.
- Each check ran once. The results show that the path works, not how often it works.


## 11. First checks through Pi (2026-09-23)

These checks ran Pi itself. Pi 0.85.1 ran non-interactively inside a disposable macOS 26 virtual machine, with `--print --mode json`. It loaded only this worktree's secretary extension and the LiteLLM provider. The planner was Qwen 3.8 27B, and the allowed tools were `computer_observe` and `computer_run_plan`. The executor was the live service at `http://jev.home.arpa`. Claude Code started the virtual machine and collected the evidence, but it did not take part in the runs. Safari covered the other windows, as in [Section 10](#10-standalone-script-checks-in-a-macos-virtual-machine-2026-09-23).

| Run | Task | Tool calls | Result |
| --- | --- | --- | --- |
| 1 | Compute 7 plus 3 in Calculator. | 2 observations and 3 plans | The final answer, 10, was correct and verified by the last plan. |
| 2 | Add a new last line "Hello from Pi" to the TextEdit document. | 3 observations and 4 plans | The line landed at the end of the document. The final answer claimed more than the harness verified. |

**What worked:**

- Pi loaded the extension, registered both tools, and passed the planner's calls to the harness.
- Each observation carried a screenshot to the planner.
- A plan with an empty postcondition was rejected before any action, and the planner corrected it.

**What failed:**

- **Postconditions that were already true.** The planner twice wrote a postcondition that held before its step: "text contains 7" for the Add step, and "window title contains scratch.txt" for a Cmd+Down step. The precheck skipped both steps. In run 1 the skipped Add step made the sum wrong until the planner replanned.
- **Content missing from the element table.** The table listed Calculator's buttons but not its display, because the display is descendant text of the window rather than an element. The planner could not read the result from the table.
- **Actions with no visible effect.** A click into the text area and the Cmd+Down key changed nothing in the element tree. The harness therefore sent each action twice and escalated `no_progress`, although the later text entry shows that Cmd+Down had moved the insertion point to the end.
- **A label used as content.** The planner wrote "text contains All Clear" to check a button name. The `text` predicate searches values and descendant text only, so a successful press was reported as failed.
- **An unverified final claim.** The final answer of run 2 said that the text was "the new last line". The harness had verified only that the document contained it.
- **Covered windows in the evidence.** The relay's desktop screenshots show Safari in front and only an edge of TextEdit.

**Test tooling:** An `osascript` query to System Events in the guest stalled until the relay timed out, and the relay recorded that run as uncertain. The document text was then read from the harness's own observation records instead.

**Verification limits:** Each task ran once. The covered-window typing problem of Section 10.2 did not recur, because the planner moved the insertion point with Cmd+Down before typing, so its cause is still unknown. The fixes are planned in `.plans/2026-09-23-computer-use-live-fixes.md`, which is not versioned.
