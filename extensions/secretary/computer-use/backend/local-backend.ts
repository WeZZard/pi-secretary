import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descendantTextByIndex } from "./cua-markdown.ts";
import { BackendError, type ActionOutcome, type BackendAction, type Delivery, type ExecutionBackend, type ForegroundState, type Point, type RawElement, type ReadOptions, type WindowRead, type WindowRef, type WindowTarget } from "./backend.ts";

/**
 * Development backend over the host's own cua-driver (design §11.3).
 * It only reads in Phase 1; it never launches, focuses, or clicks.
 */

export type DriverRunner = (tool: string, args: Record<string, unknown>, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<unknown>;

export function cuaDriverRunner(driverPath: string): DriverRunner {
  return (tool, args, { timeoutMs, signal }) => new Promise((resolve, reject) => {
    execFile(driverPath, ["call", tool, "--json", JSON.stringify(args)], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          const named = error as NodeJS.ErrnoException & { killed?: boolean };
          if (named.name === "AbortError") return reject(new BackendError("aborted", `cua-driver ${tool} was cancelled`));
          if (named.killed) return reject(new BackendError("timeout", `cua-driver ${tool} exceeded ${timeoutMs} ms`));
          return reject(new BackendError("driver_failed", `cua-driver ${tool} failed: ${String(stderr || error.message).trim().slice(0, 500)}`));
        }
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new BackendError("driver_failed", `cua-driver ${tool} returned output that is not JSON`)); }
      });
  });
}

/** Returns the process id of the active application, or undefined when it cannot tell. */
export type FrontmostPid = (options: { timeoutMs: number; signal?: AbortSignal }) => Promise<number | undefined>;

const lsappinfo = (args: string[], timeoutMs: number, signal?: AbortSignal) => new Promise<string>((resolve, reject) =>
  execFile("/usr/bin/lsappinfo", args, { timeout: timeoutMs, signal }, (error, stdout) => error ? reject(error) : resolve(stdout)));

/**
 * The active application from macOS's own `lsappinfo`: two processes that took 6 to 8 ms, where
 * `list_apps` took 438 to 630 ms because it also scans installed applications (research §14.4).
 */
export const lsappinfoFrontmost: FrontmostPid = async ({ timeoutMs, signal }) => {
  const front = (await lsappinfo(["front"], timeoutMs, signal)).trim();
  if (!front) return undefined;
  const pid = /"pid"=(\d+)/.exec(await lsappinfo(["info", "-only", "pid", front], timeoutMs, signal))?.[1];
  return pid === undefined ? undefined : Number(pid);
};

interface ListedWindow { window_id: number; pid: number; app_name: string; title: string; is_on_screen: boolean; z_index?: number; layer?: number;
  bounds?: { x: number; y: number; width: number; height: number } }

/** Width of a PNG from its IHDR chunk. */
export function pngWidth(png: Buffer): number | undefined {
  return png.length >= 24 && png.readUInt32BE(12) === 0x49484452 ? png.readUInt32BE(16) : undefined;
}

export interface LocalBackendOptions {
  run: DriverRunner;
  /** The walk cap passed to cua-driver as max_elements. */
  maxTreeNodes: number;
  timeoutMs?: number;
  now?: () => number;
  /**
   * Fix plan F-2 and F-3: send clicks and modifier shortcuts with the driver's foreground delivery,
   * which makes the application active for the action and then restores the previous one. In the
   * virtual machine, a background click into an inactive TextEdit never moved the insertion point
   * in one run (0 of 6 trials) and did in another (6 of 6), so background clicks depend on hidden
   * application state; foreground delivery and bring-to-front moved it in every trial (12 of 12,
   * observed 2026-09-23). Typed characters, text navigation keys and scrolls stay background.
   */
  foregroundDelivery?: boolean;
  /** A faster source of the active application. When it fails or cannot tell, `list_apps` answers. */
  frontmostPid?: FrontmostPid;
}

const TEXT_NAVIGATION_KEYS = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);

/** Fix plan F-3: which actions need the application to be active. */
export function deliveryFor(action: BackendAction, foregroundDelivery: boolean): Delivery | undefined {
  if (action.delivery) return action.delivery;
  if (!foregroundDelivery) return undefined;
  if (action.kind === "click") return "foreground";
  // Text-editing key bindings such as Cmd+Down worked in the background; menu shortcuts need the application active.
  if (action.kind === "key" && !TEXT_NAVIGATION_KEYS.has(action.key)
    && action.modifiers.some(modifier => modifier === "cmd" || modifier === "ctrl" || modifier === "option")) return "foreground";
  return "background";
}

/** The driver's own agent-cursor overlay is a transparent full-screen window; it covers nothing. */
const DRIVER_OVERLAY = /^cua[- ]?driver$/i;

/**
 * One page-sized wheel notch moved Finder's icon view by 100 points (cua-driver 0.12.6, observed
 * 2026-09-23), well short of a page. A page scroll therefore sends enough notches to move about
 * 80 percent of the scrolled region's height, keeping some overlap as keyboard Page Down does.
 */
export const POINTS_PER_PAGE_NOTCH = 100;
export const pageNotches = (extent: number): number =>
  Math.min(50, Math.max(1, Math.round((extent * 0.8) / POINTS_PER_PAGE_NOTCH)));

export class LocalDriverBackend implements ExecutionBackend {
  readonly kind = "local" as const;
  readonly #options: LocalBackendOptions;
  /**
   * Windows read at least once by this backend. Applications build parts of their
   * accessibility tree on first access: Safari's first read lacked the whole web area,
   * and the second read had it (observed 2026-09-23). The first read of each window is
   * therefore a discarded warm-up read.
   */
  readonly #warmed = new Set<string>();
  /**
   * Screenshot pixels per point for each window. cua-driver's pixel actions take window-local
   * screenshot pixels, and get_screen_size reported scale 1.0 while a 656-point window produced
   * a 1312-pixel screenshot (observed 2026-09-23), so the scale is learned from a screenshot.
   */
  readonly #scale = new Map<string, number>();
  constructor(options: LocalBackendOptions) { this.#options = options; }

  async #findWindow(target: WindowTarget, signal?: AbortSignal): Promise<WindowRef> {
    const listed = await this.#options.run("list_windows", {}, { timeoutMs: this.#timeout, signal }) as { windows?: ListedWindow[] };
    const app = target.app.trim().toLowerCase();
    const ofApp = (listed.windows ?? []).filter(window => window.app_name.toLowerCase() === app);
    if (ofApp.length === 0) throw new BackendError("app_not_running", `No window of ${target.app} is open. This tool does not launch applications.`);
    const titles = () => ofApp.filter(window => window.title !== "").map(window => JSON.stringify(window.title)).join(", ") || "none with a title";
    const title = target.windowTitle?.toLowerCase();
    const matching = target.windowId !== undefined ? ofApp.filter(window => window.window_id === target.windowId)
      : ofApp.filter(window => title === undefined ? window.title !== "" : window.title.toLowerCase().includes(title));
    if (target.windowId !== undefined && matching.length === 0) {
      throw new BackendError("window_not_found", `The ${target.app} window that was observed is closed. Windows: ${titles()}.`);
    }
    // A lower z_index is nearer the front: Safari at 13 was drawn over TextEdit at 36 (observed 2026-09-23).
    const onScreen = matching.filter(window => window.is_on_screen).sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
    if (target.single && target.windowId === undefined && onScreen.length > 1) {
      throw new BackendError("window_ambiguous", `${onScreen.length} ${target.app} windows match${target.windowTitle ? ` ${JSON.stringify(target.windowTitle)}` : ""}: `
        + `${onScreen.map(window => JSON.stringify(window.title)).join(", ")}. Name one with window_title, or plan against an observation of it with based_on.`);
    }
    const chosen = onScreen[0];
    if (!chosen && matching.length > 0) {
      // Observed 2026-09-23: a visible window briefly reported is_on_screen false.
      throw new BackendError("window_not_found", `The ${target.app} window ${JSON.stringify(matching[0]!.title)} exists but is not on screen; it may be minimized, hidden, or on another Space.`);
    }
    if (!chosen) {
      throw new BackendError("window_not_found", `No on-screen ${target.app} window matches${target.windowTitle ? ` ${JSON.stringify(target.windowTitle)}` : ""}. Windows: ${titles()}.`);
    }
    return { pid: chosen.pid, windowId: chosen.window_id, app: chosen.app_name, title: chosen.title };
  }

  get #timeout(): number { return this.#options.timeoutMs ?? 15_000; }

  async #isActive(pid: number, signal?: AbortSignal): Promise<boolean> {
    if (this.#options.frontmostPid) {
      try {
        const front = await this.#options.frontmostPid({ timeoutMs: this.#timeout, signal });
        if (front !== undefined) return front === pid;
      } catch (error) {
        if (signal?.aborted) throw new BackendError("aborted", "reading the active application was cancelled");
      }
    }
    const apps = await this.#options.run("list_apps", {}, { timeoutMs: this.#timeout, signal }) as { apps?: { pid: number; active?: boolean }[] } | { pid: number; active?: boolean }[];
    return (Array.isArray(apps) ? apps : apps.apps ?? []).some(app => app.pid === pid && app.active === true);
  }

  async readWindow(target: WindowTarget, options: ReadOptions): Promise<WindowRead> {
    const now = this.#options.now ?? (() => performance.now());
    const started = now();
    const window = await this.#findWindow(target, options.signal);
    const appActive = await this.#isActive(window.pid, options.signal);
    const shotDir = options.screenshot ? await mkdtemp(join(tmpdir(), "secretary-computer-use-")) : undefined;
    try {
      const key = `${window.pid}:${window.windowId}`;
      if (!this.#warmed.has(key)) {
        await this.#options.run("get_window_state", { pid: window.pid, window_id: window.windowId, max_elements: this.#options.maxTreeNodes, include_screenshot: false },
          { timeoutMs: this.#timeout, signal: options.signal });
        this.#warmed.add(key);
      }
      const args: Record<string, unknown> = { pid: window.pid, window_id: window.windowId, max_elements: this.#options.maxTreeNodes };
      if (shotDir) args.screenshot_out_file = join(shotDir, "window.png");
      else args.include_screenshot = false;
      const state = await this.#options.run("get_window_state", args, { timeoutMs: this.#timeout, signal: options.signal }) as
        { elements?: RawElement[]; element_count?: number; snapshot_id?: string; screenshot_file_path?: string; tree_markdown?: string };
      if (!Array.isArray(state.elements)) throw new BackendError("driver_failed", "cua-driver get_window_state returned no structured elements");
      const count = state.element_count ?? state.elements.length;
      let screenshot: WindowRead["screenshot"];
      if (shotDir) {
        let png: Buffer | undefined;
        try { png = await readFile(state.screenshot_file_path ?? join(shotDir, "window.png")); }
        catch { png = undefined; }
        if (png) {
          screenshot = { data: png.toString("base64"), mimeType: "image/png" };
          // The scale is a by-product; failing to learn it here only defers learning to the first action.
          await this.#learnScale(window, png, options.signal).catch(() => undefined);
        }
      }
      const descendantText = typeof state.tree_markdown === "string" ? descendantTextByIndex(state.tree_markdown) : undefined;
      return { window, appActive, snapshotId: state.snapshot_id, elements: state.elements, ...(descendantText ? { descendantText } : {}), truncated: count >= this.#options.maxTreeNodes,
        ...(screenshot ? { screenshot } : {}), readMs: now() - started };
    } finally {
      if (shotDir) await rm(shotDir, { recursive: true, force: true });
    }
  }

  async #bounds(window: WindowRef, signal?: AbortSignal) {
    const listed = await this.#options.run("list_windows", { pid: window.pid }, { timeoutMs: this.#timeout, signal }) as { windows?: ListedWindow[] };
    const found = (listed.windows ?? []).find(candidate => candidate.window_id === window.windowId);
    if (!found?.bounds) throw new BackendError("window_not_found", `The ${window.app} window ${JSON.stringify(window.title)} is no longer open.`);
    if (!found.is_on_screen) throw new BackendError("window_not_found", `The ${window.app} window ${JSON.stringify(window.title)} is not on screen; real input needs a visible window.`);
    return found.bounds;
  }

  async #learnScale(window: WindowRef, png: Buffer, signal?: AbortSignal): Promise<number> {
    const width = pngWidth(png);
    const bounds = await this.#bounds(window, signal);
    if (!width || bounds.width <= 0) throw new BackendError("driver_failed", "The window screenshot has no usable size.");
    const scale = width / bounds.width;
    this.#scale.set(`${window.pid}:${window.windowId}`, scale);
    return scale;
  }

  async #scaleFor(window: WindowRef, signal?: AbortSignal): Promise<number> {
    const known = this.#scale.get(`${window.pid}:${window.windowId}`);
    if (known !== undefined) return known;
    const shotDir = await mkdtemp(join(tmpdir(), "secretary-computer-use-"));
    try {
      const path = join(shotDir, "scale.png");
      await this.#options.run("get_window_state", { pid: window.pid, window_id: window.windowId, max_elements: 1, screenshot_out_file: path },
        { timeoutMs: this.#timeout, signal });
      return await this.#learnScale(window, await readFile(path), signal);
    } finally {
      await rm(shotDir, { recursive: true, force: true });
    }
  }

  /** Converts screen points to the window-local screenshot pixels that pixel actions take. */
  async #pixels(window: WindowRef, point: { x: number; y: number }, signal?: AbortSignal) {
    const scale = await this.#scaleFor(window, signal);
    const bounds = await this.#bounds(window, signal);
    const x = (point.x - bounds.x) * scale, y = (point.y - bounds.y) * scale;
    if (x < 0 || y < 0 || x > bounds.width * scale || y > bounds.height * scale) {
      throw new BackendError("driver_failed", `The target point lies outside the ${window.app} window; the window may have moved since the observation.`);
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  /**
   * Fix plan F-3. The active flag comes from `frontmostPid`, else `list_apps`. A window covers the point when it is an
   * on-screen layer-0 window nearer the front, which means a lower `z_index`, whose bounds contain
   * the point. The driver's own overlay window is ignored.
   */
  async foreground(window: WindowRef, point: Point | undefined, signal?: AbortSignal): Promise<ForegroundState> {
    const active = await this.#isActive(window.pid, signal);
    const listed = await this.#options.run("list_windows", {}, { timeoutMs: this.#timeout, signal }) as { windows?: ListedWindow[] };
    const windows = listed.windows ?? [];
    const target = windows.find(candidate => candidate.window_id === window.windowId);
    if (!target || point === undefined) return { active, coveredBy: [] };
    const coveredBy = windows.filter(other => other.window_id !== window.windowId && other.is_on_screen && (other.layer ?? 0) === 0
      && !DRIVER_OVERLAY.test(other.app_name) && (other.z_index ?? 0) < (target.z_index ?? 0) && other.bounds
      && point.x >= other.bounds.x && point.x <= other.bounds.x + other.bounds.width && point.y >= other.bounds.y && point.y <= other.bounds.y + other.bounds.height)
      .map(other => other.app_name);
    return { active, coveredBy: [...new Set(coveredBy)] };
  }

  async bringToFront(window: WindowRef, signal?: AbortSignal): Promise<void> {
    await this.#options.run("bring_to_front", { pid: window.pid, window_id: window.windowId }, { timeoutMs: this.#timeout, signal });
  }

  async act(window: WindowRef, action: BackendAction, signal?: AbortSignal): Promise<ActionOutcome> {
    const delivery = deliveryFor(action, this.#options.foregroundDelivery ?? false);
    const base = { pid: window.pid, window_id: window.windowId, ...(delivery ? { delivery_mode: delivery } : {}) };
    let result: unknown;
    if (action.kind === "click") {
      const { x, y } = await this.#pixels(window, action.point, signal);
      const args = { ...base, x, y };
      result = action.button === "right" ? await this.#options.run("right_click", args, { timeoutMs: this.#timeout, signal })
        : action.count === 2 ? await this.#options.run("double_click", args, { timeoutMs: this.#timeout, signal })
        : await this.#options.run("click", args, { timeoutMs: this.#timeout, signal });
    } else if (action.kind === "scroll") {
      const { x, y } = await this.#pixels(window, action.point, signal);
      result = await this.#options.run("scroll", { ...base, x, y, direction: action.direction, by: action.by, amount: pageNotches(action.extent) },
        { timeoutMs: this.#timeout, signal });
    } else {
      result = await this.#options.run("press_key", { ...base, key: action.key, ...(action.modifiers.length ? { modifiers: action.modifiers } : {}) },
        { timeoutMs: this.#timeout, signal });
    }
    const effect = (result as { effect?: string } | undefined)?.effect;
    return effect === "unverifiable" ? { kind: "unverifiable", detail: "the driver cannot read back this input" } : { kind: "completed", ...(effect ? { detail: effect } : {}) };
  }

  async close(): Promise<void> {}
}
