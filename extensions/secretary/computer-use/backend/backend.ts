/**
 * Execution backend interface (design docs/arch/computer-use.md §11.1).
 * Every action is real pointer or keyboard input (relay decision D3); no backend action
 * activates an element through the accessibility API.
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
   * Text of unindexed static-text descendants, keyed by the nearest indexed ancestor's
   * element_index. It names rows and cells whose own label is empty.
   */
  descendantText?: Record<number, string>;
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

/** A point in screen coordinates, in points, with a top-left origin, as accessibility frames report them. */
export interface Point { x: number; y: number }

export type BackendAction =
  | { kind: "click"; point: Point; button: "left" | "right"; count: 1 | 2 }
  | { kind: "key"; key: string; modifiers: string[] }
  /** `extent` is the height in points of the region being scrolled; a page is most of it. */
  | { kind: "scroll"; point: Point; direction: "up" | "down"; by: "page"; extent: number };

/** `unverifiable` is the driver's normal report for key input; code verifies the effect afterwards. */
export interface ActionOutcome { kind: "completed" | "unverifiable"; detail?: string }

export interface ExecutionBackend {
  readonly kind: "local" | "relay" | "fake";
  readWindow(target: WindowTarget, options: ReadOptions): Promise<WindowRead>;
  act(window: WindowRef, action: BackendAction, signal?: AbortSignal): Promise<ActionOutcome>;
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
