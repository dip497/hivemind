import { test } from "node:test";
import assert from "node:assert/strict";
import { isBinaryText } from "../../src/renderer/src/code/oversize";
import { OVERSIZE_SENTINEL } from "../../src/shared/ipc";

test("a NUL near the start makes a file binary, as git decides", () => {
  assert.equal(isBinaryText("\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), true);
  assert.equal(isBinaryText("export const a = 1;\n"), false);
  assert.equal(isBinaryText(undefined), false);
  assert.equal(isBinaryText("x".repeat(8000) + "\0"), false);
});

test("the too-large sentinel is not mistaken for a binary file", () => {
  assert.equal(isBinaryText(`${OVERSIZE_SENTINEL}2000000`), false);
});
