/**
 * Execution backend interface (design docs/arch/computer-use.md §11.1).
 * Phase 1 implements window reading and lifetime only; actions arrive in Phase 3.
 */

export interface Frame { x: number; y: number; w: number; h: number }

/** One entry of cua-driver's structured `elements` array (design §2.3.1). */
export interface RawElement {
  element_index: number;
  element_token?: string;
  role: string;
  label?: string;
  value?: string;
  enabled?: boolean;
  selected?: boolean;
  frame?: Frame;
  parent_index?: number;
  depth: number;
}

export interface WindowRef { pid: number; windowId: number; app: string; title: string }

export interface WindowTarget { app: string; windowTitle?: string }

export interface Screenshot { data: string; mimeType: string }

export interface WindowRead {
  window: WindowRef;
  snapshotId?: string;
  elements: RawElement[];
  /**
   * True when the window's application is the system's active application, which owns the
   * menu bar. A background application's menu bar reports frames where the active
   * application's menu bar is drawn, so real input there would reach another application.
   * Window stacking order is not a substitute: a background launch can raise a window
   * without activating its application (both observed 2026-09-23).
   */
  appActive: boolean;
  /** True when a driver or transport cap cut the tree short (design §6.1). */
  truncated: boolean;
  screenshot?: Screenshot;
  /** Backend-side time from issuing the read to receiving the parsed result. */
  readMs: number;
}

export interface ReadOptions { screenshot: boolean; signal?: AbortSignal }

export interface ExecutionBackend {
  readonly kind: "local" | "relay" | "fake";
  readWindow(target: WindowTarget, options: ReadOptions): Promise<WindowRead>;
  close(): Promise<void>;
}

export type BackendErrorCode = "app_not_running" | "window_not_found" | "driver_failed" | "timeout" | "aborted";

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  constructor(code: BackendErrorCode, message: string) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}
