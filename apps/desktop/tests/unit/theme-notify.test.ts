// A terminal program told the background went light or dark after it started (mode 2031), and
// what it reads when it starts (COLORFGBG): the sequences, through a real xterm parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import { answerThemeNotify, colorFgBg, isDarkBackground, ThemeNotify } from "../../src/renderer/src/theme-notify";

/** A headless terminal starting on a dark background, and what it sent its program. */
function terminal(dark = true) {
  const term = new headless.Terminal({ allowProposedApi: true });
  const notify = new ThemeNotify(dark);
  const sent: string[] = [];
  answerThemeNotify(term.parser, notify, (r) => sent.push(r));
  const write = (s: string) => new Promise<void>((done) => term.write(s, done));
  return { term, notify, sent, write };
}

test("a program that sets mode 2031 hears each change of background, as 997;1 for dark and 997;2 for light, until it clears it", async () => {
  const { notify, sent, write } = terminal(true);
  assert.equal(notify.theme(false), null, "not asked for yet");
  assert.equal(notify.theme(true), null);
  await write("\x1b[?2031h");
  assert.equal(notify.theme(false), "\x1b[?997;2n");
  assert.equal(notify.theme(false), null, "the same background again is no change");
  assert.equal(notify.theme(true), "\x1b[?997;1n");
  await write("\x1b[?2031l");
  assert.equal(notify.theme(false), null);
  assert.deepEqual(sent, []);
});

test("2031 set among other modes counts, and those modes still reach xterm", async () => {
  const { term, notify, write } = terminal(true);
  await write("\x1b[?2004;2031h");
  assert.equal(notify.theme(false), "\x1b[?997;2n");
  assert.equal(term.modes.bracketedPasteMode, true);
});

test("CSI ? 996 n is answered with what the background is now, asked for or not; other status requests are xterm's", async () => {
  const { term, notify, sent, write } = terminal(true);
  const xterm: string[] = [];
  term.onData((d) => xterm.push(d));
  await write("\x1b[?996n");
  notify.theme(false);
  await write("\x1b[?996n");
  await write("\x1b[?6n");
  assert.deepEqual(sent, ["\x1b[?997;1n", "\x1b[?997;2n"]);
  assert.deepEqual(xterm, ["\x1b[?1;1R"], "the cursor's place, answered by xterm itself");
});

test("a background is dark or light by its luminance, and COLORFGBG says the same", () => {
  for (const dark of ["#000000", "#1a1c1f", "#282a36", "#002b36", "#300A24", "#3b4252"]) assert.equal(isDarkBackground(dark), true, dark);
  for (const light of ["#ffffff", "#fdf6e3", "#f5f5f4", "#eee", "#a0a0a0"]) assert.equal(isDarkBackground(light), false, light);
  // Unreadable: the terminal's own default, dark.
  assert.equal(isDarkBackground("rgba(0,0,0,0)"), true);
  assert.equal(colorFgBg(true), "15;0");
  assert.equal(colorFgBg(false), "0;15");
});
