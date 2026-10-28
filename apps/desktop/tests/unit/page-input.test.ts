// What a viewer on another device may do to a page the app window holds: only these, in range.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageInputOf } from "../../src/shared/page-input";

test("a viewer may send the page to a web address, never to a file or a script on the host", () => {
  assert.deepEqual(pageInputOf({ kind: "open", url: "https://example.com/a" }), { kind: "open", url: "https://example.com/a" });
  assert.ok(pageInputOf({ kind: "open", url: "http://127.0.0.1:3000/" }));
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "hm-view://x/", "data:text/html,hi"]) {
    assert.equal(pageInputOf({ kind: "open", url }), null, url);
  }
});

test("a click or a scroll lands on the picture, or is refused", () => {
  const click = { kind: "mouse", type: "mousePressed", x: 0.5, y: 1, button: "left", clickCount: 1, modifiers: 0 };
  assert.ok(pageInputOf(click));
  assert.equal(pageInputOf({ ...click, x: 1.5 }), null);
  assert.equal(pageInputOf({ ...click, y: -0.1 }), null);
  assert.equal(pageInputOf({ ...click, x: Number.NaN }), null);
  assert.equal(pageInputOf({ ...click, button: "back" }), null);
  assert.equal(pageInputOf({ kind: "wheel", x: 0.2, y: 0.2, deltaX: 0, deltaY: 1e9, modifiers: 0 }), null);
});

test("only the kinds of input a page takes pass", () => {
  assert.equal(pageInputOf({ kind: "evaluate", expression: "document.cookie" }), null);
  assert.equal(pageInputOf(null), null);
  assert.equal(pageInputOf("click"), null);
  assert.equal(pageInputOf({ kind: "go", to: "home" }), null);
  assert.ok(pageInputOf({ kind: "go", to: "back" }));
  assert.ok(pageInputOf({ kind: "key", type: "keyDown", key: "a", code: "KeyA", keyCode: 65, text: "a", modifiers: 0 }));
});
