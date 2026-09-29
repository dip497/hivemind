/**
 * What main calls a tile in its banners (hcp/names.ts) + the reply-forward gate that dropped
 * every pi worker's report (main/index.ts `turn` handler).
 *
 * The forward gate is inline in index.ts (Electron-bound, can't be imported here),
 * so `pickReply` below MIRRORS it exactly. If you change the gate in index.ts,
 * change it here — the regression it guards is silent: the report just never
 * arrives, and the parent sits waiting forever with no error anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StatusStore } from "@hivemind/agent-host/status-store";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { labelOf } from "../../src/main/hcp/names.js";
import { makeDispatch } from "../../src/main/hcp/methods.js";
import { TurnTracker } from "../../src/main/hcp/turn-tracker.js";
import { OutputRecorder } from "../../src/main/hcp/output-recorder.js";
import { useAuthoredAgents } from "./authored-agents.ts";

// The spawn path reads the live catalog: load the published fixtures.
useAuthoredAgents();

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

test("a banner calls a tile what every surface does, on one line, with its id; a tile no workspace holds, by its id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcp-names-"));
  const workspaces = new WorkspaceStore({ dir });
  workspaces.setCore("/w", { frames: [], tiles: [
    { id: "tile-a", kind: "claude", label: "claude #1" },
    { id: "tile-b", kind: "claude", label: "claude #2", task: "fix the flaky test" },
    { id: "tile-c", kind: "claude", label: "claude #3" },
    { id: "tile-d", kind: "shell", label: "shell #1" },
  ], tileNames: { "tile-a": "lead\nreviewer" } });
  const status = new StatusStore();
  status.title("tile-b", "reading the logs");
  const label = (tileId: string) => labelOf(tileId, workspaces, status);
  assert.equal(label("tile-a"), "lead reviewer (tile-a)", "a name someone gave it, which cannot forge a second line");
  assert.equal(label("tile-b"), "reading the logs (tile-b)", "else what its agent says it is doing");
  assert.equal(label("tile-c"), "claude #3 (tile-c)");
  assert.equal(label("tile-nowhere"), "tile-nowhere");
  // Closed, its name goes with it: an id is never reused, but nothing of it lingers either.
  workspaces.removeTile("tile-a");
  assert.equal(label("tile-a"), "tile-a");
  fs.rmSync(dir, { recursive: true, force: true });
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
    awaitingApproval: () => {},
  } as unknown as Parameters<typeof makeDispatch>[0]);

  await dispatch("tile.spawn_agent", { agent: "pi", name: "student-fe", callerTile: "hm:tile-p" });
  assert.equal(seen[0]?.name, "student-fe", "the renderer must receive the name: it names the tile, and every banner reads it from there");
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
