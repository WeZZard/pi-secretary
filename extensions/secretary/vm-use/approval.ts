import { describeApproval, type ApprovalAnswer, type ApprovalRequest, type Approver } from "./executor.ts";

/**
 * The approval channel (design docs/arch/vm-use.md §8.4). The delegated agent runs
 * without an interface, so the main session's installation registers the person's confirmation
 * dialog here, in the same process. The parent agent has no tool that reaches it.
 */

/** The part of Pi's extension UI that the channel uses. */
export interface ConfirmUI { confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean> }

export const APPROVAL_TITLE = "vm-use needs approval";
const SHOWN_STEPS = 8;
const LINE_LIMIT = 160;

// Keyed on the global symbol registry, so a session that loads the extension module again still finds it.
const CHANNEL = Symbol.for("secretary.vm-use.approval-channel");
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

/** The dialog's message: the application and window, each step that needs approval with why, then the agent's goal. */
export function approvalMessage(request: ApprovalRequest, timeoutMs: number): string {
  const lines = [
    `Application: ${cut(request.app)}`,
    `Window: ${request.window !== undefined ? cut(request.window) : "(as observed)"}`,
    `${request.steps.length === 1 ? "This step needs" : "These steps need"} approval:`,
  ];
  for (const step of request.steps.slice(0, SHOWN_STEPS)) {
    const target = step.ui_element !== undefined ? ` ${cut(step.ui_element)}` : step.keys !== undefined ? ` ${step.keys}` : "";
    lines.push(`- ${step.id}: ${step.action ?? "action chosen at run time"}${target}`);
    if (step.text !== undefined) lines.push(`  Text to type: ${JSON.stringify(cut(step.text))}`);
    lines.push(`  The agent's step: ${cut(step.intent)}`, `  Why: ${describeApproval(step.why, request.failure)}.`);
  }
  if (request.steps.length > SHOWN_STEPS) lines.push(`- and ${request.steps.length - SHOWN_STEPS} more`);
  lines.push(
    `The agent's goal: ${cut(request.goal)}`,
    "",
    `Approving runs the whole plan without stopping. Declining stops it. Without an answer in ${Math.round(timeoutMs / 60_000) || 1} min, the plan stops and nothing is sent.`,
  );
  return lines.join("\n");
}

/**
 * An approver that asks through a confirmation dialog. A dialog that closes at its timeout is
 * `timeout`, and one closed because the run was cancelled is `cancelled`, not a refusal.
 */
export function confirmApprover(ui: ConfirmUI, timeoutMs: number, now: () => number = Date.now): Approver {
  return async (request, signal): Promise<ApprovalAnswer> => {
    if (signal?.aborted) return "cancelled";
    const started = now();
    let approved: boolean;
    try { approved = await ui.confirm(APPROVAL_TITLE, approvalMessage(request, timeoutMs), { timeout: timeoutMs, ...(signal ? { signal } : {}) }); }
    catch { return signal?.aborted ? "cancelled" : "no_interface"; }
    if (approved) return "approved";
    if (signal?.aborted) return "cancelled";
    // The dialog closes itself at the timeout; a refusal in the last quarter second reads as a timeout, which also sends nothing.
    return now() - started >= timeoutMs - 250 ? "timeout" : "declined";
  };
}
