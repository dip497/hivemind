// A widget's text is one line cut short by default; a text node that asks to wrap is shown whole,
// so a widget can show a long title without losing the end of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WidgetBody } from "../../src/renderer/src/board-objects/WidgetBody.tsx";

const shown = (node: Record<string, unknown>) => renderToStaticMarkup(createElement(WidgetBody, {
  id: "w1", widget: "@demo/board", name: "Board", repo: null, drawing: { tree: node } as never,
}));
const cut = (html: string) => /class="[^"]*\btruncate\b/.test(html);

test("a text node that asks to wrap is shown whole, on as many lines as it needs", () => {
  const html = shown({ type: "text", text: "FAS-1 · Document utils.py", size: "large", wrap: true });
  assert.ok(html.includes("FAS-1 · Document utils.py"), html);
  assert.equal(cut(html), false, `the title is cut short: ${html}`);
  assert.match(html, /break-words/);
});

test("a text node that does not ask stays one line, cut short", () => {
  assert.equal(cut(shown({ type: "text", text: "FAS-1 · Document utils.py" })), true);
});
