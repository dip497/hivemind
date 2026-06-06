import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveActive } from "../../src/renderer/src/editor-active";

// Drive resolveActive across "renders" exactly the way EditorTile does: each
// render feeds the current tabs + activate-request, then carries forward
// prevTabs/active/lastSeq. This models the real component without a DOM.
function makeEditor() {
  let prevTabs: string[] = [];
  let active: string | null = null;
  let lastSeq = -1;
  return {
    render(tabs: string[], req: { path: string; seq: number } | null) {
      const next = resolveActive({ tabs, prevTabs, active, req, lastSeq });
      prevTabs = tabs;
      active = next.active;
      lastSeq = next.seq;
      return active;
    },
    /** Simulate a tab-bar click (component calls setActive directly), then the
     *  reconcile effect runs with the new active. */
    manualSwitch(to: string, tabs: string[], req: { path: string; seq: number } | null) {
      active = to;
      const next = resolveActive({ tabs, prevTabs, active, req, lastSeq });
      prevTabs = tabs;
      active = next.active;
      lastSeq = next.seq;
      return active;
    },
  };
}

// THE REPORTED BUG: open file 1, open file 2, click file 1 again → must switch
// back to file 1. Before the fix, re-clicking an open file deduped to no tab
// change and the editor stayed on file 2.
test("re-clicking an already-open file switches back to its tab", () => {
  const ed = makeEditor();
  assert.equal(ed.render(["a.ts"], { path: "a.ts", seq: 1 }), "a.ts"); // open A
  assert.equal(ed.render(["a.ts", "b.ts"], { path: "b.ts", seq: 2 }), "b.ts"); // open B (active)
  // re-click A: tabs deduped (unchanged); only the request (fresh seq) carries it
  assert.equal(ed.render(["a.ts", "b.ts"], { path: "a.ts", seq: 3 }), "a.ts");
});

test("opening a brand-new file focuses it (most-recent wins)", () => {
  const ed = makeEditor();
  ed.render(["a.ts"], { path: "a.ts", seq: 1 });
  // a new tab arriving with a stale/no request still gets focus
  assert.equal(ed.render(["a.ts", "c.ts"], { path: "a.ts", seq: 1 }), "c.ts");
});

test("closing the active tab elsewhere falls back to the last remaining", () => {
  const ed = makeEditor();
  ed.render(["a.ts"], { path: "a.ts", seq: 1 });
  ed.render(["a.ts", "b.ts"], { path: "b.ts", seq: 2 }); // active = b
  assert.equal(ed.render(["a.ts"], { path: "b.ts", seq: 2 }), "a.ts"); // b gone → a
});

test("a request is honored exactly once — a manual switch isn't clobbered", () => {
  const ed = makeEditor();
  assert.equal(ed.render(["a.ts", "b.ts"], { path: "a.ts", seq: 5 }), "a.ts"); // req → a
  // user clicks tab b in the bar; the stale req (seq 5 already consumed) must NOT
  // yank focus back to a.
  assert.equal(ed.manualSwitch("b.ts", ["a.ts", "b.ts"], { path: "a.ts", seq: 5 }), "b.ts");
});

test("closing all tabs clears the active selection", () => {
  const ed = makeEditor();
  ed.render(["a.ts"], { path: "a.ts", seq: 1 });
  assert.equal(ed.render([], null), null);
});
