import { test } from "node:test";
import assert from "node:assert/strict";
import { oscColorReply } from "../../src/renderer/src/osc-color";

test("answers in the X11 form xterm uses, 16 bits a channel", () => {
  assert.equal(oscColorReply("#300A24"), "rgb:3030/0a0a/2424");
  assert.equal(oscColorReply("#1a1c1f"), "rgb:1a1a/1c1c/1f1f");
});

test("short and bare hex are the same colour", () => {
  assert.equal(oscColorReply("#fff"), "rgb:ffff/ffff/ffff");
  assert.equal(oscColorReply("282a36"), "rgb:2828/2a2a/3636");
});

// Anything that is not a plain colour is left to xterm's own answer.
test("declines what it cannot state as one colour", () => {
  for (const v of ["rgba(0,0,0,0)", "transparent", "", "#12345", "#gggggg"]) {
    assert.equal(oscColorReply(v), null);
  }
});
