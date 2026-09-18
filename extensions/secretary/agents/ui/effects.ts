import type { AgentRowView, AgentSnapshot } from "../records.ts";
import type { Operation, UiEffect, UiEvent } from "./state.ts";
import type { TranscriptEvent } from "./transcript-events.ts";
export interface OperationReceipt { outcome: "accepted" | "rejected" | "uncertain"; message: string }
export interface AgentUIPort {
  list(): AgentSnapshot[];
  viewModels?(): AgentRowView[];
  transcript(agentId: string): Promise<readonly TranscriptEvent[]>;
  message(agentId: string, text: string, operationId: string): Promise<unknown>;
  stop(runId: string, operationId: string): Promise<unknown>;
  cleanup(agentId: string, operationId: string): Promise<unknown>;
  subscribe(fn: () => void): () => void;
  receipt?(operationId: string): unknown;
}
export function rejection(error: unknown): OperationReceipt {
  const e = error as { definitive?: boolean; message?: string };
  return { outcome: e?.definitive === true ? "rejected" : "uncertain", message: e?.message ?? String(error) };
}
export async function runEffect(effect: UiEffect, port: AgentUIPort, dispatch: (event: UiEvent) => void): Promise<void> {
  if (effect.type === "load") {
    try { dispatch({ ...effect, type: "transcript", events: await port.transcript(effect.agentId) }); }
    catch (error) { dispatch({ ...effect, type: "transcript", error: String(error) }); }
  } else if (effect.type === "operate" || effect.type === "receipt") {
    const op = effect.operation;
    const report = (receipt: OperationReceipt) => dispatch({ type: "outcome", epoch: op.epoch, viewId: op.viewId, operationId: op.id, ...receipt });
    if (effect.type === "receipt") {
      try {
        const receipt = await port.receipt?.(op.id) as Partial<OperationReceipt> | undefined;
        if (receipt && receipt.outcome !== "uncertain") report({ outcome: receipt.outcome === "rejected" ? "rejected" : "accepted", message: receipt.message ?? "Recorded acceptance. This does not mean completion." });
      } catch { /* Keep uncertainty; never retry a mutation. */ }
      return;
    }
    try {
      let result: unknown;
      if (op.action === "message") result = await port.message(op.agentId, op.text, op.id);
      else if (op.action === "stop" && op.target.action === "stop") result = await port.stop(op.target.runId, op.id);
      else result = await port.cleanup(op.agentId, op.id);
      const receipt = result as Partial<OperationReceipt> | undefined;
      if (receipt?.outcome === "uncertain" || receipt?.outcome === "rejected") report({ outcome: receipt.outcome, message: receipt.message ?? receipt.outcome });
      else report({ outcome: "accepted", message: receipt?.message ?? `${op.action} accepted. Acceptance does not mean completion or consumption.` });
    } catch (error) { report(rejection(error)); }
  }
}
export const operationTarget = (operation: Operation) => operation.action === "stop" && operation.target.action === "stop" ? operation.target.runId : operation.agentId;
