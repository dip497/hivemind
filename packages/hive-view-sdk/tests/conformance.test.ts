// The view protocol held to the cases the phone's core reads too (crates/hive-phone/tests/viewing.rs):
// conformance/view-commands.json, the permission each command needs, from which the phone tells what
// starts or closes something on the board and asks its lock first; and conformance/view-surfaces.json,
// the surface rects a page may post, which a phone that places its own surfaces takes as this SDK does.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMMAND_PERMISSION, parsePluginMessage } from "../src/protocol.js";

const cases = JSON.parse(readFileSync(new URL("../../../conformance/view-commands.json", import.meta.url), "utf8")) as {
  commands: Record<string, string | null>;
};

test("each command needs the permission conformance/view-commands.json says, and it has every command", () => {
  expect(COMMAND_PERMISSION).toEqual(cases.commands);
});

type Surface = { tile: string; x: number; y: number; w: number; h: number; bar: boolean };
const surfaces = JSON.parse(readFileSync(new URL("../../../conformance/view-surfaces.json", import.meta.url), "utf8")) as {
  posted: Array<{ text: string; surfaces: Surface[] | null; why: string }>;
};

test("what a page posts is taken as surface rects, and as which, as conformance/view-surfaces.json says", () => {
  for (const c of surfaces.posted) {
    let raw: unknown;
    try { raw = JSON.parse(c.text); } catch { raw = undefined; }
    const parsed = raw === undefined ? null : parsePluginMessage(raw);
    const taken = parsed?.ok && parsed.msg.type === "surfaceRects"
      ? parsed.msg.rects.map((r) => ({ tile: r.tileId, x: r.x, y: r.y, w: r.w, h: r.h, bar: r.chrome === "bar" }))
      : null;
    expect([c.why, taken]).toEqual([c.why, c.surfaces]);
  }
});
