import type { ApprovalAnswer, ApprovalRequest, Approver } from "./harness.ts";

/**
 * The approval channel (design docs/arch/computer-use-permissions.md §8). The delegated agent runs
 * without an interface, so the main session's installation registers the person's confirmation
 * dialog here, in the same process. The parent agent has no tool that reaches it.
 */

/** The part of Pi's extension UI that the channel uses. */
export interface ConfirmUI { confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean> }

export const APPROVAL_TITLE = "Computer use needs approval";
const SHOWN_LINES = 6;
const LINE_LIMIT = 160;

// Keyed on the global symbol registry, so a session that loads the extension module again still finds it.
const CHANNEL = Symbol.for("secretary.computer-use.approval-channel");
type Holder = { [CHANNEL]?: { approver: Approver } };

/** Registers the main session's approver; the returned function removes it if it is still the registered one. */
export function openApprovalChannel(approver: Approver): () => void {
  const entry = { approver };
  (globalThis as Holder)[CHANNEL] = entry;
  return () => { if ((globalThis as Holder)[CHANNEL] === entry) delete (globalThis as Holder)[CHANNEL]; };
}

/** The approver the delegated agent uses: whatever the main session registered when the question arises. */
export const channelApprover: Approver = (request, signal) => {
  const entry = (globalThis as Holder)[CHANNEL];
  return entry ? entry.approver(request, signal) : Promise.resolve("no_interface");
};

const cut = (text: string) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > LINE_LIMIT ? `${flat.slice(0, LINE_LIMIT - 1)}…` : flat; };

/** The dialog's message: the facts of the action first, then why it asks, then the planner's own words. */
export function approvalMessage(request: ApprovalRequest, reason: string, timeoutMs: number): string {
  const { action } = request;
  const target = action.control ? ` ${action.control.role.replace(/^AX/, "")} ${JSON.stringify(cut(action.control.name))}`
    : action.keys !== undefined ? ` ${action.keys}` : "";
  const lines = [
    `Application: ${cut(action.app)}`,
    `Window: ${cut(action.window) || "(untitled)"}`,
    `Action: ${action.action}${target}`,
    ...(action.text !== undefined ? [`Text to type: ${JSON.stringify(cut(action.text))}`] : []),
    ...(action.shownText?.length ? ["The window shows:", ...action.shownText.slice(0, SHOWN_LINES).map(text => `  ${cut(text)}`)] : []),
    `Why it asks: ${reason}.`,
    `The agent's step: ${cut(request.intent)}`,
    `The agent's goal: ${cut(request.goal)}`,
    "",
    `Approving sends this one action. Declining stops the plan. Without an answer in ${Math.round(timeoutMs / 60_000) || 1} min, the plan stops and nothing is sent.`,
  ];
  return lines.join("\n");
}

/**
 * An approver that asks through a confirmation dialog. A dialog that closes at its timeout is
 * `timeout`, and one closed because the run was cancelled is `cancelled`, not a refusal.
 */
export function confirmApprover(ui: ConfirmUI, timeoutMs: number, describe: (request: ApprovalRequest) => string, now: () => number = Date.now): Approver {
  return async (request, signal): Promise<ApprovalAnswer> => {
    if (signal?.aborted) return "cancelled";
    const started = now();
    let approved: boolean;
    try { approved = await ui.confirm(APPROVAL_TITLE, approvalMessage(request, describe(request), timeoutMs), { timeout: timeoutMs, ...(signal ? { signal } : {}) }); }
    catch { return signal?.aborted ? "cancelled" : "no_interface"; }
    if (approved) return "approved";
    if (signal?.aborted) return "cancelled";
    // The dialog closes itself at the timeout; a refusal in the last quarter second reads as a timeout, which also sends nothing.
    return now() - started >= timeoutMs - 250 ? "timeout" : "declined";
  };
}
