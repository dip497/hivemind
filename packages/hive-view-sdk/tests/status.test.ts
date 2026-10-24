// The one table of status looks (src/status.ts) that the app and every view draw from: each tone a
// word and a shape of its own, so no state is told by colour alone; only what waits on you pulses;
// and a view's mark takes the host's colour for the tone, never one of its own.
import { describe, expect, test } from "bun:test";
import { STATUS_TONES } from "../src/protocol.ts";
import { STATUS_MARKS, statusMarkSvg } from "../src/status.ts";

describe("status marks", () => {
  test("every tone has a word and a shape of its own", () => {
    expect(Object.keys(STATUS_MARKS).sort()).toEqual([...STATUS_TONES].sort());
    expect(new Set(STATUS_TONES.map((t) => STATUS_MARKS[t].path)).size).toBe(STATUS_TONES.length);
    expect(new Set(STATUS_TONES.map((t) => STATUS_MARKS[t].word)).size).toBe(STATUS_TONES.length);
  });

  test("only needing you pulses", () => {
    expect(STATUS_TONES.filter((t) => STATUS_MARKS[t].pulse)).toEqual(["attention"]);
  });

  test("a view's mark is the tone's shape in the host's colour for it, at the size asked", () => {
    const svg = statusMarkSvg("failed", 10);
    expect(svg).toContain(`d="${STATUS_MARKS.failed.path}"`);
    expect(svg).toContain("color:var(--hm-status-failed)");
    expect(svg).toContain('width="10"');
    expect(svg).toContain('aria-hidden="true"');
  });
});
