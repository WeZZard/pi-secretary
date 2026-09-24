import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { BackendError, type ExecutionBackend, type WindowRead } from "../backend/backend.ts";
import type { ComputerUseConfiguration } from "../configuration.ts";
import { discardSummary, observe, renderPlannerTable, type Observation, type ObservationFailure } from "../observer.ts";
import type { Telemetry } from "../telemetry.ts";

/** `computer_observe` (design docs/arch/computer-use.md §5.1). */

export type ScreenshotDisposition = "included" | "omitted_model_text_only" | "omitted_unavailable";

export interface ObserveDetails {
  observationId: string;
  status: Observation["status"] | ObservationFailure["status"] | "backend_failed";
  app?: string;
  window?: string;
  groups?: number;
  elements?: number;
  discards?: Record<string, number>;
  screenshot?: ScreenshotDisposition;
  attempts: number;
  recordPath?: string;
  error?: string;
}

export interface ObserveDependencies {
  backend: ExecutionBackend;
  telemetry: Telemetry;
  config: ComputerUseConfiguration;
  /** Retains ready observations so a later plan can cite `basedOn` (design §5.2). */
  remember(observation: Observation): void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  newId?: () => string;
}

/** A window that is still appearing is read again, at most twice (design §8, rule 2). */
const MAX_READ_ATTEMPTS = 3;

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new BackendError("aborted", "observation was cancelled")); }, { once: true });
});

export async function executeObserve(
  deps: ObserveDependencies,
  params: { app: string; window_title?: string },
  modelAcceptsImages: boolean,
  signal?: AbortSignal,
): Promise<AgentToolResult<ObserveDetails>> {
  const observationId = (deps.newId ?? (() => `obs-${randomUUID().slice(0, 8)}`))();
  const sleep = deps.sleep ?? defaultSleep;
  let read: WindowRead | undefined;
  let result: Observation | ObservationFailure | undefined;
  let recordPath: string | undefined;
  let attempts = 0;
  try {
    for (attempts = 1; attempts <= MAX_READ_ATTEMPTS; attempts++) {
      read = await deps.backend.readWindow({ app: params.app, ...(params.window_title ? { windowTitle: params.window_title } : {}) },
        { screenshot: modelAcceptsImages, signal });
      result = observe(read, { id: attempts === 1 ? observationId : `${observationId}-${attempts}`, maxElements: deps.config.maxElements, maxNameLength: deps.config.maxNameLength });
      recordPath = await deps.telemetry.recordObservation(read, result, { attempt: attempts, purpose: "computer_observe" });
      if (result.status !== "window_missing" || attempts === MAX_READ_ATTEMPTS) break;
      await sleep(deps.config.settleMs, signal);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof BackendError && error.code === "state_too_large" ? "state_too_large" : "backend_failed";
    return { content: [{ type: "text", text: status === "state_too_large" ? `Observation failed. Status: state_too_large. ${message}` : `Observation failed: ${message}` }],
      details: { observationId, status, attempts, error: message, ...(recordPath ? { recordPath } : {}) } };
  }
  const finalRead = read!;
  const final = result!;
  const header = [`Application: ${finalRead.window.app}`, `Window: ${JSON.stringify(finalRead.window.title)}`, `Observation: ${final.id}`];
  if (final.status !== "ready") {
    const escalation = final.status === "state_too_large" ? "state_too_large" : "no_progress";
    return { content: [{ type: "text", text: `${header.join("\n")}\nStatus: ${escalation}. ${final.detail}` }],
      details: { observationId: final.id, status: final.status, app: finalRead.window.app, window: finalRead.window.title, attempts, recordPath,
        discards: discardSummary(final.discards) } };
  }
  deps.remember(final);
  const elementCount = final.groups.reduce((sum, group) => sum + group.elements.length, 0);
  const screenshot: ScreenshotDisposition = !modelAcceptsImages ? "omitted_model_text_only" : finalRead.screenshot ? "included" : "omitted_unavailable";
  const note = screenshot === "omitted_model_text_only" ? "Screenshot omitted: the current model does not accept images."
    : screenshot === "omitted_unavailable" ? "Screenshot omitted: the backend did not return one." : "Screenshot attached.";
  const summary = discardSummary(final.discards);
  const discarded = Object.entries(summary).filter(([, count]) => count > 0).map(([reason, count]) => `${reason} ${count}`).join(", ");
  const text = [...header,
    `Elements: ${elementCount} in ${final.groups.length} group${final.groups.length === 1 ? "" : "s"}. Discarded: ${discarded || "none"}.`,
    note, "", elementCount === 0 ? "No actionable named elements are visible." : renderPlannerTable(final)].join("\n");
  const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
  if (screenshot === "included") content.push({ type: "image", data: finalRead.screenshot!.data, mimeType: finalRead.screenshot!.mimeType });
  return { content, details: { observationId: final.id, status: "ready", app: finalRead.window.app, window: finalRead.window.title,
    groups: final.groups.length, elements: elementCount, discards: summary, screenshot, attempts, recordPath } };
}
