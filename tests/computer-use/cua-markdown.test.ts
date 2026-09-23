import assert from "node:assert/strict";
import { test } from "node:test";
import { descendantTextByIndex } from "../../extensions/secretary/computer-use/backend/cua-markdown.ts";
import { observe, type Observation } from "../../extensions/secretary/computer-use/observer.ts";

// Shape recorded from the TextEdit Open panel sidebar on 2026-09-23, with folder names replaced.
const SIDEBAR = [
  "- [0] AXWindow \"Open\" [actions=[raise]]",
  "  - AXSplitGroup",
  "    - AXOutline (sidebar)",
  "      - [14] AXRow [actions=[showdefaultui,showalternateui]]",
  "        - [15] AXCell [actions=[open]]",
  "          - AXStaticText = \"Downloads\"",
  "          - AXImage (Arrow Down Circle)",
  "      - [16] AXRow [actions=[showdefaultui,showalternateui]]",
  "      - AXStaticText = \"Locations\"",
  "      - [17] AXRow [actions=[showdefaultui]]",
  "        - [18] AXCell [actions=[open]]",
  "          - AXStaticText \"Say \\\"hi\\\"\"",
].join("\n");

test("unindexed static text names its nearest indexed ancestor only", () => {
  assert.deepEqual(descendantTextByIndex(SIDEBAR), { 0: "Locations", 15: "Downloads", 18: "Say \"hi\"" });
});

test("the observer uses descendant text only when label and value are empty", () => {
  const frame = (y: number) => ({ x: 10, y, w: 150, h: 30 });
  const result = observe({
    window: { pid: 1, windowId: 1, app: "TextEdit", title: "Open" }, appActive: false, truncated: false, readMs: 0,
    elements: [
      { element_index: 0, role: "AXWindow", label: "Open", depth: 0, frame: { x: 0, y: 0, w: 800, h: 600 } },
      { element_index: 14, role: "AXRow", parent_index: 0, depth: 3, frame: frame(100) },
      { element_index: 15, role: "AXCell", parent_index: 14, depth: 4, frame: frame(100) },
      { element_index: 18, role: "AXCell", parent_index: 0, depth: 4, label: "Own label", frame: frame(140) },
    ],
    descendantText: { 15: "Downloads", 18: "Ignored" },
  }, { id: "o", maxElements: 240, maxNameLength: 48 }) as Observation;
  assert.deepEqual(result.groups[0]!.elements.map(element => [element.role, element.name]), [["AXCell", "Downloads"], ["AXCell", "Own label"]]);
  assert.equal(result.discards.find(discard => discard.index === 14)?.reason, "unnamed", "The row stays unnamed, so one sidebar item yields one candidate");
});
