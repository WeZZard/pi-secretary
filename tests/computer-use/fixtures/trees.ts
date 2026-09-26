import type { RawElement, WindowRead } from "../../../extensions/secretary/computer-use/backend/backend.ts";

/**
 * Hand-built trees shaped like cua-driver 0.12.6 output recorded on 2026-09-23.
 * They contain no captured user data.
 */

let next = 0;
export function element(role: string, fields: Partial<RawElement> = {}): RawElement {
  return { element_index: next++, role, depth: 0, ...fields };
}
export function resetIndices(): void { next = 0; }

const frame = (x: number, y: number, w = 60, h = 20) => ({ x, y, w, h });

/** TextEdit plain-text document in the background: menu items without frames, unlabeled title-bar buttons. */
export function textEditRead(): Omit<WindowRead, "readMs"> {
  resetIndices();
  const bar = element("AXMenuBar", { label: "_NS:834", frame: frame(0, 0, 2560, 30) });
  const file = element("AXMenuBarItem", { label: "File", parent_index: bar.element_index, depth: 1 });
  const menu = element("AXMenu", { parent_index: file.element_index, depth: 2 });
  const save = element("AXMenuItem", { label: "Save…", parent_index: menu.element_index, depth: 3 });
  const window = element("AXWindow", { label: "scratch.txt", frame: frame(309, 103, 656, 422) });
  const text = element("AXTextArea", { label: "Disposable document text", value: "Disposable document text", parent_index: window.element_index, depth: 1, frame: frame(309, 135, 656, 384) });
  const close = element("AXButton", { enabled: true, parent_index: window.element_index, depth: 1, frame: frame(317, 111, 16, 16) });
  return { window: { pid: 1, windowId: 10, app: "TextEdit", title: "scratch.txt" }, appActive: false, snapshotId: "s0001", truncated: false,
    elements: [bar, file, menu, save, window, text, close] };
}

/** A Finder-like window with a toolbar, a sidebar outline and a content list, large enough to need routing. */
export function finderRead(options: { sheet?: boolean; contentItems?: number } = {}): Omit<WindowRead, "readMs"> {
  resetIndices();
  const elements: RawElement[] = [];
  const add = (role: string, fields: Partial<RawElement> = {}) => { const created = element(role, fields); elements.push(created); return created; };
  const window = add("AXWindow", { label: "Documents", frame: frame(0, 0, 1200, 1600) });
  const toolbar = add("AXToolbar", { parent_index: window.element_index, depth: 1, frame: frame(0, 30, 1200, 50) });
  ["Back", "Forward", "New Folder", "Share", "Tags", "Search"].forEach((label, i) =>
    add("AXButton", { label, parent_index: toolbar.element_index, depth: 2, frame: frame(100 + i * 70, 40) }));
  const sidebar = add("AXOutline", { parent_index: window.element_index, depth: 1, frame: frame(0, 80, 200, 700) });
  ["Recents", "Applications", "Desktop", "Documents", "Downloads"].forEach((label, i) =>
    add("AXRow", { label, parent_index: sidebar.element_index, depth: 2, frame: frame(10, 100 + i * 24, 180) }));
  const list = add("AXList", { parent_index: window.element_index, depth: 1, frame: frame(200, 80, 1000, 1500) });
  const count = options.contentItems ?? 20;
  for (let i = 0; i < count; i++) add("AXStaticText", { label: `File ${String(i + 1).padStart(2, "0")}`, parent_index: list.element_index, depth: 2, frame: frame(220, 90 + i * 22, 300) });
  add("AXStaticText", { label: "Virtual row", parent_index: list.element_index, depth: 2, frame: frame(220, 1590, 300, 1) });
  add("AXButton", { label: "Disabled action", enabled: false, parent_index: toolbar.element_index, depth: 2, frame: frame(900, 40) });
  if (options.sheet) {
    const sheet = add("AXSheet", { parent_index: window.element_index, depth: 1, frame: frame(300, 100, 500, 200) });
    add("AXTextField", { label: "Folder name", value: "untitled folder", parent_index: sheet.element_index, depth: 2, frame: frame(320, 140, 300) });
    add("AXButton", { label: "Cancel", parent_index: sheet.element_index, depth: 2, frame: frame(500, 250) });
    add("AXButton", { label: "Create", parent_index: sheet.element_index, depth: 2, frame: frame(600, 250) });
  }
  return { window: { pid: 2, windowId: 20, app: "Finder", title: "Documents" }, appActive: true, snapshotId: "s0002", truncated: false, elements };
}

/**
 * The iOS Simulator on the iOS Settings Search page, with the frames of a read recorded through Pi
 * on 2026-09-26 (research §16.8): the macOS menu bar, toolbar, title-bar buttons and hardware
 * buttons, and the device screen's iOS elements, all flat under the window with the same roles.
 * `screen: false` gives the first read of a booting Simulator, which had only the macOS elements.
 */
export function simulatorRead(options: { screen?: boolean } = {}): Omit<WindowRead, "readMs"> {
  resetIndices();
  const bar = element("AXMenuBar", { frame: frame(0, 0, 1920, 30) });
  const device = element("AXMenuBarItem", { label: "Device", parent_index: bar.element_index, depth: 1, frame: frame(120, 0, 55, 30) });
  const window = element("AXWindow", { label: "iPhone 17 – iOS 26.5", frame: frame(740, 35, 440, 940) });
  const child = (role: string, label: string | undefined, f: ReturnType<typeof frame>, extra: Partial<RawElement> = {}) =>
    element(role, { ...(label ? { label } : {}), parent_index: window.element_index, depth: 1, frame: f, ...extra });
  const hardware = [child("AXButton", "Action", frame(740, 250, 17, 35)), child("AXButton", "Volume Up", frame(740, 309, 17, 64)),
    child("AXButton", "Volume Down", frame(740, 385, 17, 64)), child("AXButton", "Sleep/Wake", frame(1163, 349, 17, 99))];
  const screen = options.screen === false ? [] : [
    child("AXButton", "Settings", frame(781, 174, 42, 42)),
    child("AXHeading", "Search", frame(933, 185, 54, 20)),
    child("AXCheckBox", "Show Recent Searches", frame(801, 275, 319, 27), { value: "1" }),
    child("AXButton", "Search Engine", frame(785, 444, 349, 51)),
    child("AXButton", "App Clips", frame(785, 720, 349, 50)),
  ];
  const toolbar = child("AXToolbar", undefined, frame(740, 35, 440, 52));
  const tools = ["Home", "Save Screen", "Rotate"].map((label, i) => element("AXButton", { label, parent_index: toolbar.element_index, depth: 2, frame: frame(1047 + 45 * i, 35, 43, 52) }));
  const title = child("AXStaticText", "iPhone 17", frame(832, 35, 207, 52));
  return { window: { pid: 1355, windowId: 44, app: "Simulator", title: "iPhone 17" }, appActive: true, snapshotId: "s0003", truncated: false,
    elements: [bar, device, window, ...hardware, ...screen, toolbar, ...tools, title] };
}
