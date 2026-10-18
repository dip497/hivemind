// The showcase views in examples/views: each manifest is one this app loads, with the commands an
// agent runs, and what each view draws is worked out right from the workspace it is given.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateViewManifest } from "@hivemind/view-sdk/manifest";
// @ts-expect-error plain JavaScript modules, loaded as the view loads them
import * as sky from "../../../examples/views/constellation/lib.js";
// @ts-expect-error
import * as day from "../../../examples/views/timeline/lib.js";
// @ts-expect-error
import * as board from "../../../examples/views/agents-by-state/lib.js";
// @ts-expect-error
import * as map from "../../../examples/views/workspace-map/lib.js";

const ROOT = path.resolve(import.meta.dir, "../../../examples/views");

test("every view in the repository is a view this app loads, with the commands an agent runs", () => {
  for (const name of readdirSync(ROOT)) {
    const m = validateViewManifest(JSON.parse(readFileSync(path.join(ROOT, name, "hivemind-view.json"), "utf8")));
    expect([name, m.ok && m.manifest.commands.length > 0]).toEqual([name, true]);
  }
});

test("Constellation: an agent's light follows what it reports, and a worktree sits by the frame it came from", () => {
  expect(sky.lightOf("working", { state: "working" })).toBe("working");
  expect(sky.lightOf("idle", { state: "waiting", waitingFor: "permission" })).toBe("waiting");
  expect(sky.lightOf("blocked", undefined)).toBe("waiting");
  expect(sky.lightOf("idle", { state: "limited" })).toBe("failed");
  const frames = [{ id: "a" }, { id: "b" }, { id: "w", parentId: "a" }];
  const tiles = [{ id: "1", frameId: "a", agent: "claude" }, { id: "2", frameId: "w", agent: "codex" }, { id: "3", frameId: "a", kind: "term" }];
  const { frames: at, orbits } = sky.layout(frames, tiles);
  const dist = (p: { x: number; z: number }, q: { x: number; z: number }) => Math.hypot(p.x - q.x, p.z - q.z);
  expect(dist(at.get("w"), at.get("a"))).toBeLessThan(Math.min(8, dist(at.get("w"), at.get("b"))));
  expect([...orbits.keys()].sort()).toEqual(["1", "2", "3"]);
  expect(orbits.get("1").radius).toBeGreaterThan(orbits.get("3").radius);
  expect(sky.census(["working", "waiting", "working", "idle"])).toEqual({ working: 2, waiting: 1, idle: 1, failed: 0, exited: 0 });
});

test("Timeline: a live status change ends the stretch before it and starts one that runs to now", () => {
  let it: [number, number, string][] = [[0, 100, "idle"]];
  it = day.extend(it, "working", 150, 200);
  it = day.extend(it, "working", 150, 260);
  it = day.extend(it, "blocked", 300, 330);
  expect(it).toEqual([[0, 150, "idle"], [150, 300, "working"], [300, 330, "blocked"]]);
  expect(day.minutesIn([[0, 600_000, "working"], [600_000, 900_000, "blocked"]], 300_000)).toEqual({ working: 5, blocked: 5, idle: 0, exited: 0, unknown: 0 });
  const s = day.span([{ intervals: [[1_000_000, 2_000_000, "working"]] }], 5_000_000);
  expect(s.from).toBeLessThan(1_000_000);
  expect(s.to).toBeGreaterThanOrEqual(5_000_000);
});

test("Agents by state: each agent lands in its column, the one waiting longest first", () => {
  expect(board.columnOf("blocked", {})).toBe("waiting");
  expect(board.columnOf("working", { state: "working" })).toBe("working");
  expect(board.columnOf("idle", { state: "failed" })).toBe("stopped");
  expect(board.columnOf("exited", undefined)).toBe("stopped");
  expect(board.columnOf("idle", { state: "idle" })).toBe("idle");
  const by = board.group([
    { id: "late", column: "waiting", since: 300 }, { id: "early", column: "waiting", since: 100 }, { id: "w", column: "working", since: 50 },
  ]);
  expect(by.waiting.map((c: { id: string }) => c.id)).toEqual(["early", "late"]);
  expect(board.detailOf({ column: "waiting", waitingFor: "plan" })).toBe("has a plan for you");
});

test("Workspace map: a worktree hangs under its frame, every tile under its own, and a parent sits between its children", () => {
  const frames = [{ id: "a", title: "api" }, { id: "w", title: "fix", parentId: "a" }];
  const tiles = [{ id: "1", frameId: "a" }, { id: "2", frameId: "w" }, { id: "3", frameId: "w" }, { id: "4", frameId: null }];
  const { nodes, rows } = map.tree(frames, tiles);
  const by = new Map(nodes.map((n: { id: string }) => [n.id, n]));
  expect(["w", "1", "2", "3", "4"].map((id) => (by.get(id) as { parent: string }).parent)).toEqual(["a", "a", "w", "w", "workspace"]);
  expect(rows).toBe(4);
  const w = by.get("w") as { row: number };
  expect(w.row).toBe(((by.get("2") as { row: number }).row + (by.get("3") as { row: number }).row) / 2);
  expect(map.issueCounts([{ state: "done" }, { state: "done" }, { state: "todo" }])).toEqual({ done: 2, todo: 1 });
});
