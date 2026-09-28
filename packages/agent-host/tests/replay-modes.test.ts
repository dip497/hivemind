// A real headless terminal, fed what an agent's TUI sends: the replay has to carry the
// encoding the app asked for, or its mouse is answered in a dialect it does not read.
import { test, expect } from "bun:test";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { mouseEncodingSeq } from "../src/replay-modes.ts";

/** Writes are parsed asynchronously: wait for the write to land before reading the modes. */
const fed = async (seq: string) => {
  const t = new Terminal({ allowProposedApi: true });
  await new Promise<void>((r) => t.write(seq, r));
  return t;
};

test("what a TUI turned on comes back: the tracking mode from the replay, the encoding from us", async () => {
  const t = await fed("\x1b[?1049h\x1b[?1003h\x1b[?1006hhello");
  const ser = new SerializeAddon();
  t.loadAddon(ser);
  const replay = ser.serialize();
  expect(replay).toContain("\x1b[?1003h");      // tracking: xterm's addon writes it
  expect(replay).not.toContain("\x1b[?1006h");  // encoding: it does not — this is the gap
  expect(mouseEncodingSeq(t)).toBe("\x1b[?1006h");
});

test("pixel coordinates carry too, and a terminal nobody asked for the mouse says nothing", async () => {
  expect(mouseEncodingSeq(await fed("\x1b[?1003h\x1b[?1016h"))).toBe("\x1b[?1016h");
  expect(mouseEncodingSeq(await fed("hello"))).toBe("");
  // Encoding without tracking is not worth re-emitting: nothing is reported either way.
  expect(mouseEncodingSeq(await fed("\x1b[?1006h"))).toBe("");
  expect(mouseEncodingSeq(null)).toBe("");
  expect(mouseEncodingSeq({})).toBe("");
});
