// A widget's card takes the note colour its drawing asks for (`tint`), on the board and on the
// screen: from what its code drew, as a sticky note's comes from its package's `draw`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_WIDGETS, type WidgetPackage } from "@hivemind/core/widget-format";
import type { WidgetObject } from "@hivemind/workspace-doc/shapes";
import { widgetLook } from "../../src/renderer/src/board-objects/WidgetBody";

const note = BUILTIN_WIDGETS.find((p) => p.id === "note")!;
const coded: WidgetPackage = { ...note, id: "@me/mood", name: "Mood", code: "hive.render({})", draw: undefined, options: [] };
const placed = (widget: string, options?: Record<string, unknown>): WidgetObject => ({ id: "widget-1", kind: "widget", widget, ...(options ? { options } : {}) } as WidgetObject);

test("a tint the widget's code draws colours its card", () => {
  const drawing = { tree: { type: "stack", tint: "pink", children: [{ type: "text", text: "sad" }] }, chrome: "card" as const };
  assert.equal(widgetLook(placed(coded.id), coded, drawing).tint, "var(--color-note-pink)");
  assert.equal(widgetLook(placed(coded.id), coded, { ...drawing, tree: { ...drawing.tree, tint: "blue" } }).tint, "var(--color-note-blue)");
  assert.equal(widgetLook(placed(coded.id), coded, undefined).tint, null);
});

test("a sticky note's tint is the colour it was set to", () => {
  assert.equal(widgetLook(placed("note", { color: "green" }), note, undefined).tint, "var(--color-note-green)");
});
