// Pure DOM focus-target predicates that decide whether a key types into a field
// or acts on the canvas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inEditable, inTextField } from "../../src/renderer/src/dom-focus.ts";

const el = (tag: string, opts: { cls?: string; ce?: boolean } = {}) => ({
  tagName: tag,
  isContentEditable: !!opts.ce,
  classList: { contains: (c: string) => c === opts.cls },
}) as unknown as EventTarget;

test("inEditable: INPUT / TEXTAREA / contentEditable are editable; others not", () => {
  assert.equal(inEditable(el("INPUT")), true);
  assert.equal(inEditable(el("TEXTAREA")), true);
  assert.equal(inEditable(el("DIV", { ce: true })), true);
  assert.equal(inEditable(el("DIV")), false);
  assert.equal(inEditable(null), false);
});

test("inTextField: INPUT yes; TEXTAREA yes UNLESS it's xterm's helper textarea", () => {
  assert.equal(inTextField(el("INPUT")), true);
  assert.equal(inTextField(el("TEXTAREA")), true);
  assert.equal(inTextField(el("TEXTAREA", { cls: "xterm-helper-textarea" })), false);
  assert.equal(inTextField(el("DIV", { ce: true })), false); // contentEditable is not a "text field"
  assert.equal(inTextField(null), false);
});
