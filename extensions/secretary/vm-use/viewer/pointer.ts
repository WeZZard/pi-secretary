// Where a machine step clicked, and with which mouse button (decision PS-D60, design §12.3,
// Pointer; docs/ux/vm-use.md §1.2). The trajectory reads it from the command the relay recorded
// for the step, the driver's answer and the window read before the step; the page draws the
// marker from it and computes nothing. It never guesses: a position it cannot read is `unplaced`.

export type Button = "left" | "right" | "middle";

/** A point in a snapshot's pixels, and its fraction of the snapshot's width and height when the snapshot's size is known. */
export interface PointerPoint { x: number; y: number; fx?: number; fy?: number }

/** A UI element's frame in a snapshot's pixels, and its fractions of the snapshot's width and height. */
export interface PointerFrame { x: number; y: number; w: number; h: number; fx: number; fy: number; fw: number; fh: number; role?: string; name?: string }

export interface Pointer {
  /** `click` for a mouse click, `element` for an accessibility action on a UI element, `unplaced` when the step clicked but its position is not known. */
  kind: "click" | "element" | "unplaced";
  /** The driver tool the command called, such as `click` or `right_click`. */
  tool: string;
  button?: Button;
  count?: number;
  /** The modifier keys held, in the command's order. */
  modifiers?: string[];
  /** For `element`: the accessibility action, such as `press`, `show_menu` or `set_value`. */
  action?: string;
  point?: PointerPoint;
  /** The same point in screen points, when the driver or the display scale tells it. */
  points?: { x: number; y: number };
  frame?: PointerFrame;
  /** `command` when the command gave the point, `element` when it was taken from a UI element's frame. */
  source?: "command" | "element";
  /** Why there is no marker: for `unplaced`, and for a point outside the snapshot. */
  reason?: string;
}

/** A recorded UI element of a window read, as the observation record keeps it (telemetry.ts). */
export interface PointerElement { element_index: number; role: string; label?: string; value?: string; frame?: { x: number; y: number; w: number; h: number } }

/** A window read in the step's machine: its window, its UI elements in screen points, and the display scale it recorded. */
export interface PointerRead { window?: { pid?: number; windowId?: number }; elements: PointerElement[]; desktopScale?: number }

export interface PointerInput {
  /** The guest command, exactly as the relay recorded it. */
  argv?: string[];
  /** What the driver answered. */
  stdout?: string;
  /** The size of the step's snapshot, in pixels. */
  snapshot?: { width: number; height: number };
  /** The window reads recorded before the step in the same machine, the latest last. */
  reads?: PointerRead[];
}

const TOOLS = new Set(["click", "right_click", "double_click", "set_value"]);

/** The driver tool and its arguments in a recorded command: `… cua <tool> '<json>' …`. */
export function commandOf(argv: string[] | undefined): { tool: string; args: Record<string, unknown> } | undefined {
  const at = argv?.indexOf("cua") ?? -1;
  if (!argv || at < 0) return undefined;
  const tool = argv[at + 1];
  if (!tool) return undefined;
  try {
    const args = JSON.parse(argv[at + 2] ?? "{}") as unknown;
    return args && typeof args === "object" && !Array.isArray(args) ? { tool, args: args as Record<string, unknown> } : undefined;
  } catch { return undefined; }
}

/**
 * Pixels per point of a whole-display snapshot `width` pixels wide, as the relay client measures it
 * (backend/relay-client.ts): the widest menu bar spans the display in points. Outside 1 to 4 it is not
 * a display scale.
 */
export function displayScaleOf(width: number, elements: PointerElement[]): number | undefined {
  const bar = Math.max(0, ...elements.filter(element => element.role === "AXMenuBar" && element.frame).map(element => element.frame!.w));
  const scale = bar > 0 ? width / bar : undefined;
  return scale !== undefined && scale >= 1 && scale <= 4 ? scale : undefined;
}

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const round = (value: number) => Math.round(value * 1e4) / 1e4;
const inside = (x: number, y: number, size: { width: number; height: number }) => x >= 0 && y >= 0 && x < size.width && y < size.height;

/** The pointer of a machine step, or undefined when the step sent no click and acted on no UI element. */
export function pointerOf(input: PointerInput): Pointer | undefined {
  const command = commandOf(input.argv);
  if (!command || !TOOLS.has(command.tool)) return undefined;
  const { tool, args } = command;
  const unplaced = (reason: string, more: Partial<Pointer> = {}): Pointer => ({ kind: "unplaced", tool, ...more, reason });
  const modifiers = Array.isArray(args.modifier) ? args.modifier.filter((key): key is string => typeof key === "string") : [];
  const keys = modifiers.length ? { modifiers } : {};
  const button: Button = tool === "right_click" ? "right" : args.button === "right" || args.button === "middle" ? args.button : "left";
  const count = tool === "double_click" ? 2 : number(args.count) ?? 1;
  const x = number(args.x), y = number(args.y), index = number(args.element_index);

  if (index === undefined) {
    if (tool === "set_value") return undefined;
    const click = { button, count, ...keys };
    if (x === undefined || y === undefined) return unplaced("The command gave neither a point nor a UI element.", click);
    // Window-local pixels: the window screenshot's scale and origin are not recorded, so the point cannot be placed.
    if (args.scope !== "desktop") return unplaced("The command gave a point in the window's own screenshot, whose place on the display was not recorded.", click);
    // Desktop pixels are display pixels, which are the snapshot's pixels.
    const said = /screen-point \((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/.exec(input.stdout ?? "");
    const latest = input.reads?.at(-1);
    const scale = latest?.desktopScale ?? (input.snapshot && latest ? displayScaleOf(input.snapshot.width, latest.elements) : undefined);
    const points = said ? { x: Number(said[1]), y: Number(said[2]) } : scale ? { x: round(x / scale), y: round(y / scale) } : undefined;
    const pointer: Pointer = { kind: "click", tool, ...click, source: "command", ...(points ? { points } : {}) };
    if (!input.snapshot) return { ...pointer, point: { x, y }, reason: "The snapshot's size is not known." };
    const point = { x, y, fx: round(x / input.snapshot.width), fy: round(y / input.snapshot.height) };
    return inside(x, y, input.snapshot) ? { ...pointer, point } : { ...pointer, point, reason: "The point lies outside the snapshot." };
  }

  // An accessibility action on a UI element, or a middle click at its centre.
  const middle = tool === "click" && button === "middle";
  const action = tool === "set_value" ? "set_value" : tool === "right_click" ? "show_menu" : tool === "double_click" ? "open"
    : typeof args.action === "string" ? args.action : button === "right" ? "show_menu" : "press";
  const what: Partial<Pointer> = middle ? { button: "middle", count: 1, ...keys } : { action };
  // The driver keeps a window's element indices until the next read of the same window.
  const pid = number(args.pid), windowId = number(args.window_id);
  const read = input.reads?.findLast(r => (pid === undefined || r.window?.pid === pid) && (windowId === undefined || r.window?.windowId === windowId));
  if (!read) return unplaced("No read of the step's window was recorded before the step.", what);
  const element = read.elements.find(e => e.element_index === index);
  if (!element?.frame) return unplaced(`The window read before the step has no frame for UI element ${index}.`, what);
  // The driver names the UI element it acted on, such as "[12] AXTextField"; another role means another read.
  const named = new RegExp(`\\[${index}\\] (AX[A-Za-z]+)`).exec(input.stdout ?? "")?.[1];
  if (named && named !== element.role) return unplaced(`The driver acted on a ${named}, but the window read before the step has a ${element.role} at index ${index}.`, what);
  if (!input.snapshot) return unplaced("The snapshot's size is not known.", what);
  // The scale the read recorded, or for a read recorded before it kept one, the scale its menu bar gives.
  const scale = read.desktopScale ?? displayScaleOf(input.snapshot.width, read.elements);
  if (!scale) return unplaced("The display scale was not recorded, and the window read has no menu bar to measure it by.", what);
  const f = element.frame, s = input.snapshot;
  const name = element.label || element.value;
  const frame: PointerFrame = { x: round(f.x * scale), y: round(f.y * scale), w: round(f.w * scale), h: round(f.h * scale),
    fx: round(f.x * scale / s.width), fy: round(f.y * scale / s.height), fw: round(f.w * scale / s.width), fh: round(f.h * scale / s.height),
    role: element.role, ...(name ? { name } : {}) };
  if (middle) {
    const cx = round((f.x + f.w / 2) * scale), cy = round((f.y + f.h / 2) * scale);
    const pointer: Pointer = { kind: "click", tool, ...what, source: "element", frame, points: { x: round(f.x + f.w / 2), y: round(f.y + f.h / 2) },
      point: { x: cx, y: cy, fx: round(cx / s.width), fy: round(cy / s.height) } };
    return inside(cx, cy, s) ? pointer : { ...pointer, reason: "The point lies outside the snapshot." };
  }
  const pointer: Pointer = { kind: "element", tool, action, source: "element", frame };
  return inside(frame.x + frame.w / 2, frame.y + frame.h / 2, s) ? pointer : { ...pointer, reason: "The UI element lies outside the snapshot." };
}
