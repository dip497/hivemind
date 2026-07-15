/**
 * Worker display names (hcp/names.ts) + the reply-forward gate that dropped every
 * pi worker's report (main/index.ts `turn` handler).
 *
 * The forward gate is inline in index.ts (Electron-bound, can't be imported here),
 * so `pickReply` below MIRRORS it exactly. If you change the gate in index.ts,
 * change it here — the regression it guards is silent: the report just never
 * arrives, and the parent sits waiting forever with no error anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setName, labelOf } from "../../src/main/hcp/names.js";
import { makeDispatch } from "../../src/main/hcp/methods.js";
import { TurnTracker } from "../../src/main/hcp/turn-tracker.js";
import { OutputRecorder } from "../../src/main/hcp/output-recorder.js";

/** MIRROR of index.ts: transcript wins, else pi's inline turn text. */
function pickReply(
  safeTp: string | null,
  turnText: string | null,
  readTranscript: (p: string) => string,
): string {
  return safeTp ? readTranscript(safeTp) : typeof turnText === "string" ? turnText.trim() : "";
}

const TRANSCRIPT = () => "answer from the transcript";

test("pi turn (no transcript, inline text) still yields a reply — the v1.12.7 regression", () => {
  // claude/droid: transcript path present.
  assert.equal(pickReply("/home/u/.claude/x.jsonl", null, TRANSCRIPT), "answer from the transcript");
  // pi: NO transcript, reply inline. Pre-fix this returned "" and the forward
  // short-circuited, so the parent never heard back from its worker.
  assert.equal(pickReply(null, "  answer from pi  ", TRANSCRIPT), "answer from pi");
});

test("a turn with neither transcript nor text yields nothing (no empty banner)", () => {
  assert.equal(pickReply(null, null, TRANSCRIPT), "");
  assert.equal(pickReply(null, "   ", TRANSCRIPT), "");
});

test("labelOf: named worker reads as name + id; unnamed falls back to the bare id", () => {
  setName("tile-claude-1", "reviewer");
  assert.equal(labelOf("tile-claude-1"), "reviewer (tile-claude-1)");
  assert.equal(labelOf("tile-claude-unnamed"), "tile-claude-unnamed");
});

test("names are dropped on close — a recycled id must not inherit the old name", () => {
  setName("tile-claude-2", "test-writer");
  setName("tile-claude-2", null);
  assert.equal(labelOf("tile-claude-2"), "tile-claude-2");
});

test("tile.spawn_agent actually forwards `name` — it enumerates its params, and a dropped one is silent", async () => {
  // v1.13.0 shipped `name` end-to-end EXCEPT here: the tile.spawn_agent case lists
  // its params by hand, `name` wasn't in the list, and the feature was dead with no
  // error anywhere. This asserts the wire, not the sanitizer.
  const seen: Array<Record<string, unknown>> = [];
  const { dispatch } = makeDispatch({
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async (_m: string, p: unknown) => {
      seen.push(p as Record<string, unknown>);
      return { tileId: "tile-w" };
    },
    writeToTile: () => true,
    deliverToTile: () => true,
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    pushWait: () => {},
  } as unknown as Parameters<typeof makeDispatch>[0]);

  await dispatch("tile.spawn_agent", { agent: "pi", name: "student-fe", callerTile: "hm:tile-p" });
  assert.equal(seen[0]?.name, "student-fe", "the renderer must receive the name — it's the tile label");
  assert.equal(labelOf("tile-w"), "student-fe (tile-w)", "and main must remember it — it tags every report back");
});

/** MIRROR of the sanitizer in methods.ts doSpawn. */
const clean = (n: unknown): string =>
  typeof n === "string" ? n.replace(/[\p{C}]/gu, "").trim().slice(0, 40) : "";

test("name sanitizing: control chars stripped, length bounded — a name lands in the parent's terminal", () => {
  // A worker-supplied name is TYPED into the parent's TUI. ANSI/control bytes
  // would let it repaint the parent's screen or forge a second banner.
  assert.equal(clean("[31mred"), "[31mred"); // ESC + BEL gone, text kept
  assert.equal(clean("rev\niewer"), "reviewer"); // no newline → can't forge a line
  assert.equal(clean("x".repeat(200)).length, 40);
  assert.equal(clean("  spaced  "), "spaced");
  assert.equal(clean(undefined), "");
  assert.equal(clean(42), "");
});
