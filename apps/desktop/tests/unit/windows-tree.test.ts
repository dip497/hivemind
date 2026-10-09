// The Windows view's panes: splits, a pane per group of tabs, and the rules that hold whatever is
// done to them — every open tile in one pane, no empty pane but the focused one, no split of one,
// weights summing to 1, and a layout whose panes stay inside the room without overlapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PANES, closePane, equalize, layout, moveTab, neighbor, normalize, paneOf, panes, readTree, resize, single, split, toggleZoom, unsplit,
  type Node, type Tree,
} from "../../views/windows/src/tree.ts";

const ROOM = { x: 0, y: 0, w: 1000, h: 600 };

/** What must hold of a tree that has been normalized against `open`. */
function holds(tree: Tree, open: readonly string[], aside: ReadonlySet<string> = new Set()): void {
  const all = panes(tree.root);
  const shown = all.flatMap((p) => p.tabs);
  assert.deepEqual([...shown].sort(), open.filter((id) => !aside.has(id)).sort(), "each open tile once");
  assert.equal(new Set(shown).size, shown.length, "no tile in two panes");
  for (const p of all) {
    assert.ok(p.tabs.length > 0 || p.id === tree.focus, `pane ${p.id} empty but not focused`);
    assert.ok(p.active === null ? p.tabs.length === 0 : p.tabs.includes(p.active), `pane ${p.id} shows a tab it has`);
  }
  assert.ok(all.some((p) => p.id === tree.focus), "the focus is a pane");
  const walk = (n: Node, parent: string | null) => {
    if (n.t === "pane") return;
    assert.ok(n.kids.length >= 2, "no split of one");
    assert.notEqual(n.dir, parent, "no split inside a split the same way");
    assert.ok(Math.abs(n.w.reduce((a, b) => a + b, 0) - 1) < 1e-9, "weights sum to 1");
    for (const k of n.kids) walk(k, n.dir);
  };
  walk(tree.root, null);
  const l = layout(tree, ROOM, 6);
  for (const a of l.panes) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= ROOM.w && a.y + a.h <= ROOM.h, `pane ${a.id} inside the room`);
    for (const b of l.panes) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} and ${b.id} do not overlap`);
  }
}

test("a tile it has not seen joins the focused pane; a closed one leaves; a minimized one is set aside", () => {
  let t = normalize(single("p1"), ["a", "b"]);
  t = split(t, "p1", "right", "b", "p2");
  t = normalize(t, ["a", "b", "c"]);
  assert.deepEqual(panes(t.root).map((p) => p.tabs), [["a"], ["b", "c"]]);
  t = normalize(t, ["a", "c"], new Set(["c"]));
  // p2 is empty but focused: it stays, for the next tile to open in.
  assert.deepEqual(panes(t.root).map((p) => [p.id, p.tabs]), [["p1", ["a"]], ["p2", []]]);
  holds(t, ["a", "c"], new Set(["c"]));
  t = normalize({ ...t, focus: "p1" }, ["a", "c"], new Set(["c"]));
  assert.equal(t.root.t, "pane", "an empty pane without the focus goes, and its split with it");
});

test("splitting beside a pane in a split the same way adds a child there, sharing that pane's room", () => {
  let t = normalize(single("p1"), ["a", "b", "c"]);
  t = split(t, "p1", "right", "b", "p2");
  t = split(t, "p2", "right", "c", "p3");
  assert.equal(t.root.t, "split");
  if (t.root.t !== "split") return;
  assert.equal(t.root.kids.length, 3);
  assert.deepEqual(t.root.w, [0.5, 0.25, 0.25]);
  t = split(t, "p3", "down", null, "p4");
  holds(normalize(t, ["a", "b", "c"]), ["a", "b", "c"]);
  assert.equal(t.focus, "p4");
});

test("closing a pane gives its tabs to the pane that takes its room; unsplit puts every tab in one", () => {
  let t = normalize(single("p1"), ["a", "b", "c"]);
  t = split(t, "p1", "right", "b", "p2");
  t = split(t, "p2", "down", "c", "p3");
  t = closePane(t, "p3");
  assert.deepEqual(paneOf(t, "c")?.id, "p2");
  holds(normalize(t, ["a", "b", "c"]), ["a", "b", "c"]);
  const one = unsplit(t);
  assert.equal(one.root.t, "pane");
  holds(normalize(one, ["a", "b", "c"]), ["a", "b", "c"]);
});

test("a tab moved to another pane leaves the first, which goes when it is empty", () => {
  let t = normalize(single("p1"), ["a", "b"]);
  t = split(t, "p1", "right", "b", "p2");
  t = moveTab(t, "a", "p2");
  t = normalize(t, ["a", "b"]);
  assert.deepEqual(panes(t.root).map((p) => [p.id, p.tabs, p.active]), [["p2", ["b", "a"], "a"]]);
});

test("a divider moves its two panes' share, never below the smallest; equalize gives them the same", () => {
  let t = normalize(single("p1"), ["a", "b"]);
  t = split(t, "p1", "right", "b", "p2");
  t = resize(t, [], 0, 0.2);
  assert.deepEqual(t.root.t === "split" && t.root.w.map((x) => +x.toFixed(2)), [0.7, 0.3]);
  t = resize(t, [], 0, 5);
  assert.deepEqual(t.root.t === "split" && t.root.w.map((x) => +x.toFixed(2)), [0.92, 0.08]);
  t = equalize(t, []);
  assert.deepEqual(t.root.t === "split" && t.root.w, [0.5, 0.5]);
  const l = layout(t, ROOM, 6);
  assert.deepEqual(l.panes.map((p) => [p.x, p.w]), [[0, 497], [503, 497]]);
  assert.deepEqual(l.dividers.map((d) => [d.x, d.w, d.h]), [[497, 6, 600]]);
});

test("a zoomed pane takes the room alone, and comes back among the others", () => {
  let t = normalize(single("p1"), ["a", "b"]);
  t = split(t, "p1", "down", "b", "p2");
  t = toggleZoom(t, "p1");
  assert.deepEqual(layout(t, ROOM, 6).panes, [{ id: "p1", ...ROOM }]);
  t = toggleZoom(t, "p1");
  assert.equal(layout(t, ROOM, 6).panes.length, 2);
});

test("the pane on a side is the nearest one overlapping it across, in an L of three", () => {
  let t = normalize(single("p1"), ["a", "b", "c"]);
  t = split(t, "p1", "right", "b", "p2");
  t = split(t, "p2", "down", "c", "p3");
  const l = layout(t, ROOM, 6);
  assert.equal(neighbor(l, "p1", "right"), "p2");
  assert.equal(neighbor(l, "p3", "left"), "p1");
  assert.equal(neighbor(l, "p2", "down"), "p3");
  assert.equal(neighbor(l, "p1", "left"), null);
});

test("past the most panes it shows, a split changes nothing", () => {
  const open = Array.from({ length: MAX_PANES + 2 }, (_, i) => `t${i}`);
  let t = normalize(single("p0"), open);
  for (let i = 1; i <= MAX_PANES + 1; i++) t = normalize(split(t, t.focus, i % 2 ? "right" : "down", `t${i}`, `p${i}`), open);
  assert.equal(panes(t.root).length, MAX_PANES);
  holds(t, open);
});

test("any sequence of operations keeps the rules", () => {
  // A small deterministic generator, so a failure replays.
  let seed = 7;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const all = ["a", "b", "c", "d", "e", "f"];
  let open = all.slice(0, 3);
  let t = normalize(single("p0"), open);
  for (let step = 0; step < 400; step++) {
    const ids = panes(t.root).map((p) => p.id);
    const some = ids[rand(ids.length)]!;
    const tile = open[rand(open.length)] ?? null;
    switch (rand(8)) {
      case 0: t = split(t, some, (["left", "right", "up", "down"] as const)[rand(4)]!, rand(2) ? tile : null, `p${step + 1}`); break;
      case 1: t = closePane(t, some); break;
      case 2: if (tile) t = moveTab(t, tile, some); break;
      case 3: t = resize(t, [], 0, (rand(100) - 50) / 100); break;
      case 4: t = toggleZoom(t, some); break;
      case 5: open = all.filter(() => rand(3) > 0); break;
      case 6: t = { ...t, focus: some }; break;
      default: t = unsplit(t);
    }
    t = normalize(t, open);
    holds(t, open);
  }
});

test("a saved tree is read back as it was, and anything malformed is refused", () => {
  let t = normalize(single("p1"), ["a", "b"]);
  t = split(t, "p1", "right", "b", "p2");
  assert.deepEqual(readTree(JSON.parse(JSON.stringify(t))), t);
  for (const bad of [null, 3, { root: { t: "pane" }, focus: "p1" }, { root: { t: "split", dir: "row", kids: [], w: [] }, focus: "p1" }, { root: { t: "split", dir: "diag", kids: [{ t: "pane", id: "x", tabs: [] }], w: [1] }, focus: "x" }]) {
    assert.equal(readTree(bad), null, JSON.stringify(bad));
  }
});

test("a split left with one child that splits the way its parent does is merged into the parent", () => {
  let t = normalize(single("p1"), ["a", "b", "c", "d"]);
  t = split(t, "p1", "right", "b", "p2"); // row[p1, p2]
  t = split(t, "p2", "down", "c", "p3"); // row[p1, col[p2, p3]]
  t = split(t, "p3", "right", "d", "p4"); // row[p1, col[p2, row[p3, p4]]]
  t = normalize(closePane(t, "p2"), ["a", "b", "c", "d"]); // the col keeps one child, a row, inside a row
  assert.equal(t.root.t === "split" && t.root.kids.length, 3);
  holds(t, ["a", "b", "c", "d"]);
});

test("a saved tree naming a tile in two panes keeps it in the first only", () => {
  const saved: Tree = { root: { t: "split", dir: "row", w: [0.5, 0.5], kids: [{ t: "pane", id: "p1", tabs: ["a", "b"], active: "b" }, { t: "pane", id: "p2", tabs: ["b"], active: "b" }] }, focus: "p1", zoom: null };
  const t = normalize(saved, ["a", "b"]);
  assert.deepEqual(panes(t.root).map((p) => p.tabs), [["a", "b"]]);
  holds(t, ["a", "b"]);
});
