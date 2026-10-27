// Views' turn and subagent events come from the host's session statuses: a turn its hooks ended
// counts once, a screen-read idle is not a hook turn, and every change in subagents is passed on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedHostedStatus } from "../../src/renderer/src/workspace/view-services.ts";
import { ViewEventHub, type LedgerLine } from "../../src/renderer/src/workspace/view-events.ts";
import { forgetStatus, setHostedStatus, subscribeStatus } from "../../src/renderer/src/agent-status-bus.ts";

const status = (state: string, source: "hooks" | "screen" | null, subagents: string[] = []) =>
  ({ state, source, subagents, background: 0, compacting: false, since: 0 }) as never;

test("hook turn ends and subagent counts", () => {
  const got: string[] = [];
  const hub = { onHookStatus: () => {}, onHookTurn: (id: string) => got.push(`turn ${id}`), onSubagents: (id: string, n: number) => got.push(`subagents ${id} ${n}`) };
  const last = new Map();
  const feed = (tileId: string, s: unknown) => feedHostedStatus(hub as never, last, { seq: 0, tileId, status: s as never });
  feed("a", status("working", "hooks"));
  feed("a", status("working", "hooks", ["s1", "s2"]));
  feed("a", status("done", "hooks", ["s1"]));
  feed("a", status("done", "hooks", ["s1"])); // the same end, told again
  feed("a", status("working", "hooks"));
  feed("a", status("interrupted", "hooks"));
  feed("b", status("working", "screen"));
  feed("b", status("done", "screen"));
  assert.deepEqual(got, ["subagents a 2", "turn a", "subagents a 1", "subagents a 0", "turn a"]);
});

test("each turn counts once in events and in history, whichever of the window's two listeners hears its end first", () => {
  const lines: LedgerLine[] = [];
  const timers: Array<() => void> = [];
  const hub = new ViewEventHub({ schedule: (fn) => { timers.push(fn); }, ledger: (ls) => lines.push(...ls) });
  const ids = ["vh-hooked", "vh-plain", "vh-midturn"];
  hub.setWorkspace("ws", ids.map((id) => ({ id, frameId: null, kind: "agent", name: id })));
  // A turn already under way when the view host starts: the bus has its status, the feed has not.
  setHostedStatus("vh-midturn", status("working", "hooks"));
  const events: Array<{ tileId: string; inferred?: boolean }> = [];
  hub.subscribe((e) => { if (e.kind === "turn") events.push(e); return false; });
  const off = subscribeStatus((e) => hub.onStatus(e));
  const last = new Map();
  // As the window hears a session's status: the status bus subscribed when the workspace mounted,
  // the view host after it loaded, so the bus's idle comes before the hook's turn end.
  const changed = (tileId: string, s: unknown) => {
    setHostedStatus(tileId, s as never);
    feedHostedStatus(hub, last, { seq: 0, tileId, status: s as never });
  };
  try {
    changed("vh-hooked", status("idle", "hooks"));
    changed("vh-hooked", status("working", "hooks"));
    changed("vh-hooked", status("done", "hooks")); // its first turn
    changed("vh-hooked", status("working", "hooks"));
    changed("vh-hooked", status("done", "hooks"));
    changed("vh-plain", status("working", "screen"));
    changed("vh-plain", status("idle", "screen"));
    changed("vh-midturn", status("done", "hooks"));
    while (timers.length) timers.shift()!();
    const count = (list: Array<{ tileId?: string; id?: string }>) => Object.fromEntries(ids.map((id) => [id, list.filter((x) => (x.tileId ?? x.id) === id).length]));
    assert.deepEqual(count(events), { "vh-hooked": 2, "vh-plain": 1, "vh-midturn": 1 });
    assert.deepEqual(count(lines.filter((l) => l.e === "t")), { "vh-hooked": 2, "vh-plain": 1, "vh-midturn": 1 });
    assert.deepEqual(events.filter((e) => e.tileId === "vh-hooked").map((e) => !!e.inferred), [false, false]);
  } finally {
    off();
    for (const id of ids) forgetStatus(id);
  }
});
