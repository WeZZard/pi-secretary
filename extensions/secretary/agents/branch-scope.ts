import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRun } from "./records.ts";

/** Conversation visibility is separate from durable session ownership (architecture §6.4). */
export class AgentBranchScope {
  private readonly manager: ExtensionContext["sessionManager"];
  constructor(manager: ExtensionContext["sessionManager"]) { this.manager = manager; }

  admissionEntry(toolCallId?: string): string | undefined {
    if (toolCallId) {
      const entries = this.manager.getBranch();
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.type === "message" && entry.message.role === "assistant"
          && entry.message.content.some(block => block.type === "toolCall" && block.id === toolCallId)) return entry.id;
      }
      throw new Error("Agent operation correlation is missing: no generating assistant entry on the selected branch.");
    }
    return this.manager.getLeafId() ?? undefined;
  }

  private origin(run: AgentRun): string | undefined {
    if (run.parentEntryId) return run.parentEntryId;
    // Legacy records used unscoped tool-call identifiers. Only a unique structured
    // admission is evidence; prompt text, timestamps, summaries, and names are not.
    const id = run.launchKey.startsWith("message:tool:") ? run.launchKey.slice("message:tool:".length) : run.launchKey;
    const name = run.launchKey.startsWith("message:tool:") ? "SendMessage" : "Agent";
    const matches = this.manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "assistant"
      && entry.message.content.some(block => block.type === "toolCall" && block.name === name && block.id === id));
    return matches.length === 1 ? matches[0]!.id : undefined;
  }

  disposition(run: AgentRun): "visible" | "outside" | "unknown" {
    const origin = this.origin(run);
    if (!origin) return "unknown";
    // Full ancestry, not buildContextEntries(): compaction does not revoke admissions.
    return this.manager.getBranch().some(entry => entry.id === origin) ? "visible" : "outside";
  }

  operationKey(toolCallId: string): string {
    return JSON.stringify([this.admissionEntry(toolCallId), toolCallId]);
  }
}
