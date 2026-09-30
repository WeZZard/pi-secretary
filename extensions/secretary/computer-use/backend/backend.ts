/**
 * Execution backend interface (design docs/arch/computer-use.md §11.1).
 * Every action is real pointer or keyboard input (relay decision D3); no backend action
 * activates a UI element through the accessibility API.
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

/**
 * `windowId` names one window exactly, taken from an earlier read, and wins over `windowTitle`.
 * `single` refuses to choose when several windows match, instead of taking the frontmost one:
 * a Finder plan without a title acted on another Finder window (Pi task batch, 2026-09-23).
 */
export interface WindowTarget { app: string; windowTitle?: string; windowId?: number; single?: boolean }

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
  /** Relay step identifiers of this read, such as `cu-0007`, to find its evidence (design §11.2). */
  evidence?: string[];
}

/** `label` names the plan step in the relay's evidence, such as `run-muhqd509 new_line: verify` (design §11.2). */
export interface ReadOptions { screenshot: boolean; signal?: AbortSignal; label?: string }

/** A point in screen coordinates, in points, with a top-left origin, as accessibility frames report them. */
export interface Point { x: number; y: number }

/**
 * `background` posts the input to the process without raising its window. `foreground` briefly
 * brings the window to the front, acts, and restores the previous front application (fix plan F-3).
 */
export type Delivery = "background" | "foreground";

export type BackendAction = (
  | { kind: "click"; point: Point; button: "left" | "right"; count: 1 | 2 }
  | { kind: "key"; key: string; modifiers: string[] }
  /** `extent` is the height in points of the region being scrolled; a page is most of it. */
  | { kind: "scroll"; point: Point; direction: "up" | "down"; by: "page"; extent: number }
) & { delivery?: Delivery; label?: string };

/** Fix plan F-3: whether the target application is active, and which windows are drawn over a point. */
export interface ForegroundState { active: boolean; coveredBy: string[] }

/** `unverifiable` is the driver's normal report for key input; code verifies the effect afterwards. */
export interface ActionOutcome {
  kind: "completed" | "unverifiable";
  detail?: string;
  /** The driver's input path, such as `cgevent_hid`, `key_events` or `ax` (design §11.4). */
  path?: string;
  /** Relay step identifiers of this action (design §11.2). */
  evidence?: string[];
}

export interface ExecutionBackend {
  readonly kind: "local" | "relay" | "fake";
  readWindow(target: WindowTarget, options: ReadOptions): Promise<WindowRead>;
  act(window: WindowRef, action: BackendAction, signal?: AbortSignal): Promise<ActionOutcome>;
  /** Fix plan F-3: reads the foreground state from the window server. Optional for backends that cannot. */
  foreground?(window: WindowRef, point: Point | undefined, signal?: AbortSignal): Promise<ForegroundState>;
  /** Fix plan F-3: makes the window's application active and raises the window. */
  bringToFront?(window: WindowRef, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/** `state_too_large`: a transport cap cut the window's state short, as the relay's 64 KiB output cap can (design §11.2). */
export type BackendErrorCode = "app_not_running" | "window_not_found" | "window_ambiguous" | "driver_failed" | "state_too_large" | "timeout" | "aborted";

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  constructor(code: BackendErrorCode, message: string) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}
