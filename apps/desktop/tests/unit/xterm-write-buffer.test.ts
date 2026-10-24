// xterm's write buffer, in both packages the app loads (the renderer's terminal and the daemon's
// screen), held to its contract: every write is parsed once and its callback fires once, whatever
// a resize does in between. The patches in patches/@xterm__*.patch make it so; without them a
// resize while a burst was paused parsed the chunks before the pause a second time, and an empty
// write dropped every write queued behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as HeadlessNS from "@xterm/headless";
import * as XtermNS from "@xterm/xterm";

type Term = HeadlessNS.Terminal;
type Ctor = new (o: { cols: number; rows: number; scrollback: number; allowProposedApi: boolean }) => Term;
// Both are CommonJS bundles; node's ESM loader puts their exports under `default`.
const packages: [string, Ctor][] = [
  ["@xterm/headless", ((HeadlessNS as any).Terminal ?? (HeadlessNS as any).default.Terminal) as Ctor],
  ["@xterm/xterm", ((XtermNS as any).Terminal ?? (XtermNS as any).default.Terminal) as Ctor],
];

function lines(t: Term): string[] {
  const b = t.buffer.active;
  return Array.from({ length: b.length }, (_, y) => b.getLine(y)?.translateToString(true) ?? "").filter(Boolean);
}

const CHUNKS = 40;
/** A chunk heavy enough that a dozen milliseconds parse only a few of them, then the buffer yields.
 *  It leaves one line: its own name (the filler is drawn over in place, never scrolled). */
function chunk(i: number): string {
  return "\r" + "y".repeat(70).concat("\r").repeat(3000) + `\x1b[Kchunk ${i}\r\n`;
}

for (const [name, Terminal] of packages) {
  test(`${name}: a resize while a burst is paused shows each write once and calls back once`, async () => {
    const t = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    const calls = new Array<number>(CHUNKS).fill(0);
    let calledAtResize = -1;
    const all = new Promise<void>((done) => {
      for (let i = 0; i < CHUNKS; i++) {
        t.write(chunk(i), () => {
          calls[i]++;
          // The first slice has parsed its chunks and is about to yield: resize in the pause,
          // before the buffer's own timer runs the next slice.
          if (i === 0 && calls[0] === 1) setTimeout(() => { calledAtResize = calls.reduce((a, b) => a + b); t.resize(100, 30); }, 0);
          if (i === CHUNKS - 1) setTimeout(done, 0);
        });
      }
    });
    await all;
    assert.ok(calledAtResize > 0 && calledAtResize < CHUNKS, `the resize came mid-burst (${calledAtResize} of ${CHUNKS} parsed)`);
    assert.deepEqual(calls, new Array(CHUNKS).fill(1), "each write called back once");
    const shown = lines(t).filter((l) => l.startsWith("chunk "));
    assert.deepEqual(shown, Array.from({ length: CHUNKS }, (_, i) => `chunk ${i}`), "each write shown once, in order");
  });

  test(`${name}: a resize from a write's callback does not parse that write again`, async () => {
    const t = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
    const calls = [0, 0];
    const both = new Promise<void>((done) => {
      t.write("first\r\n", () => { calls[0]++; t.resize(100, 30); });
      t.write("second\r\n", () => { calls[1]++; done(); });
    });
    await both;
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls, [1, 1]);
    assert.deepEqual(lines(t), ["first", "second"]);
  });

  test(`${name}: an empty write before a resize does not drop the writes behind it`, async () => {
    const t = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
    let called = 0;
    t.write("before\r\n");
    t.write("");
    t.write("after\r\n", () => called++);
    t.resize(100, 30);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, 1, "the write behind the empty one called back");
    assert.deepEqual(lines(t), ["before", "after"]);
  });
}
