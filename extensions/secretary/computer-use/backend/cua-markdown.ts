/**
 * cua-driver's structured `elements` array holds only indexed UI elements. The text that names
 * many rows and cells, such as a sidebar's "Downloads", is an unindexed AXStaticText child that
 * appears only in `tree_markdown` (observed 2026-09-23 on Finder and the TextEdit Open panel).
 * This parser attaches each unindexed static text to its nearest indexed ancestor, so the
 * observer can use it as a fallback name. The driver documents the Markdown shape as stable
 * for text-parsing callers.
 *
 * Line shapes:
 *   <indent>- [12] AXRow [actions=[...]]
 *   <indent>- AXStaticText = "Downloads"
 *   <indent>- AXStaticText "Title"
 */

const INDEXED = /^(\s*)- \[(\d+)\] /;
const UNINDEXED_TEXT = /^(\s*)- AXStaticText(?: = "((?:[^"\\]|\\.)*)"| "((?:[^"\\]|\\.)*)")/;
const ANY_ITEM = /^(\s*)- /;

export function descendantTextByIndex(markdown: string, maxTexts = 2): Record<number, string> {
  const result: Record<number, string[]> = {};
  const stack: { indent: number; index: number }[] = [];
  for (const line of markdown.split("\n")) {
    const item = ANY_ITEM.exec(line);
    if (!item) continue;
    const indent = item[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const indexed = INDEXED.exec(line);
    if (indexed) { stack.push({ indent, index: Number(indexed[2]) }); continue; }
    const text = UNINDEXED_TEXT.exec(line);
    const owner = stack[stack.length - 1];
    if (!text || !owner) continue;
    const value = (text[2] ?? text[3] ?? "").replace(/\\(.)/g, "$1").trim();
    if (value === "") continue;
    const texts = result[owner.index] ??= [];
    if (texts.length < maxTexts) texts.push(value);
  }
  return Object.fromEntries(Object.entries(result).map(([index, texts]) => [index, texts.join(" ")]));
}
