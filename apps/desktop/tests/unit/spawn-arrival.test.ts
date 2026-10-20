// A tile the control plane opens (useSpawn's placeArrived): one the person opened is gone to; one an
// agent or a program opened leaves the person where they are, shown unread in Layers, unless their
// setting `agents.whenAgentStartsAgent` says go to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSpawn, type SpawnCtx } from "../../src/renderer/src/useSpawn.ts";
import { patchSettings } from "../../src/renderer/src/settings-store.ts";
import { isOpenedUnread } from "../../src/renderer/src/worker-tiles.ts";
import type { FrameState } from "../../src/renderer/src/canvas-persistence.ts";

/** A workspace with one frame and the lead agent in it, selected; what the window shows. */
function workspace() {
  const frame = { id: "f1", x: 0, y: 0, w: 2520, h: 1780, title: "api", color: "#888", z: 0, workspacePath: "/work/api" } as FrameState;
  const shown = { selected: "lead" as string | null, camera: null as { id: string } | null };
  const ref = <T,>(current: T) => ({ current });
  const frameOf: Record<string, string> = { lead: "f1" };
  const positions: Record<string, { x: number; y: number }> = { lead: { x: 40, y: 60 } };
  const ctx = {
    repoPath: "/work/api", positionsRef: ref(positions), sizesRef: ref({}), tilesRef: ref([{ id: "lead", kind: "claude", label: "lead" }]),
    frameOfRef: ref(frameOf), framesRef: ref([frame]), selectedFrameIdRef: ref("f1"), selectedTileIdRef: ref("lead"),
    repoPathRef: ref("/work/api"), rootRef: ref(null), lastActiveFrameRef: ref(null), boardRef: ref([]),
    setFrameOf: () => {}, setPositions: () => {}, setFrames: () => {}, setSelectedFrameId: () => {}, setTiles: () => {}, setSpawnPick: () => {},
    setSelectedTileId: (v: unknown) => { shown.selected = typeof v === "function" ? v(shown.selected) : v; },
    setFocusReq: (v: unknown) => { shown.camera = typeof v === "function" ? v(shown.camera) : v; },
    focusTile: () => {}, openFileInTile: () => {}, renameTile: () => {},
  } as unknown as SpawnCtx;
  let spawn!: ReturnType<typeof useSpawn>;
  renderToStaticMarkup(createElement(() => { spawn = useSpawn(ctx); return null; }));
  return { spawn, shown };
}

test("an agent or a program starting an agent leaves the selection and the view where they were, the new tile unread; the person's own start is gone to", () => {
  const { spawn, shown } = workspace();
  spawn.placeArrived("w-1", { background: false, by: "agent" });
  spawn.placeArrived("p-1", { background: false, by: "program" });
  assert.deepEqual([shown.selected, shown.camera, isOpenedUnread("w-1"), isOpenedUnread("p-1")], ["lead", null, true, true]);
  spawn.placeArrived("mine", { background: false, by: "person" });
  assert.deepEqual([shown.selected, shown.camera?.id, isOpenedUnread("mine")], ["mine", "mine", false]);
});

test("set to go to it, the window goes to an agent another agent starts; a background worker it still does not", () => {
  patchSettings("agents.whenAgentStartsAgent", "go");
  try {
    const { spawn, shown } = workspace();
    spawn.placeArrived("bg-1", { background: true, by: "agent" });
    assert.deepEqual([shown.selected, shown.camera], ["lead", null]);
    spawn.placeArrived("w-2", { background: false, by: "agent" });
    assert.deepEqual([shown.selected, shown.camera?.id, isOpenedUnread("w-2")], ["w-2", "w-2", false]);
  } finally {
    patchSettings("agents.whenAgentStartsAgent", "stay");
  }
});
