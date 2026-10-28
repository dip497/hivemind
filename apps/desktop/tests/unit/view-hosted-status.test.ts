// Views' turn and subagent events come from the host's session statuses: a turn its hooks ended
// counts once, a screen-read idle is not a hook turn, and every change in subagents is passed on.
// Two windows on one workspace each write a turn's line, and the day's history counts it once.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { feedHostedStatus, viewEvents, viewLinkServices } from "../../src/renderer/src/workspace/view-services.ts";
import { ViewEventHub, type LedgerLine } from "../../src/renderer/src/workspace/view-events.ts";
import { forgetStatus, setHostedStatus, subscribeStatus } from "../../src/renderer/src/agent-status-bus.ts";
import { StatusLedger } from "../../src/main/status-ledger.ts";

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

test("a view reading the day's history gets the turn that ended a moment ago, not only those the hub sent before", async () => {
  const sent: string[] = [];
  const hive = {
    viewLedgerAppend: (lines: LedgerLine[]) => { for (const l of lines) sent.push(`${l.e} ${"id" in l ? l.id : ""}`); },
    viewHistory: async () => { sent.push("history"); return { day: "2026-10-27", from: 0, to: 0, tiles: [], frames: {}, gaps: [] }; },
  };
  const was = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { hive };
  try {
    viewEvents.setWorkspace("ws-history", [{ id: "vh-now", frameId: null, kind: "agent", name: "now" }]);
    viewEvents.onHookTurn("vh-now", "done");
    const services = viewLinkServices({ layoutKey: () => "ws-history", repo: () => null, share: async () => ({ ok: false }) as never, frameFolder: () => null, isAgentTile: () => true, confirmPrompt: async () => true, issueRoot: () => null, issueFolder: () => null });
    await services.history!("2026-10-27");
    assert.deepEqual(sent.slice(sent.indexOf("t vh-now")), ["t vh-now", "history"]);
  } finally {
    viewEvents.setWorkspace(null, []);
    (globalThis as { window?: unknown }).window = was;
  }
});

test("two windows on one workspace each write a turn; the day's history counts it once, hooked or not", () => {
  const at = (m: number, sec = 0) => new Date(2026, 8, 23, 9, m, sec).getTime();
  let clock = at(0);
  const ledger = new StatusLedger(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-two-windows-")), () => clock);
  ledger.boot();
  const hooked = (state: string, since: number) => ({ state, source: "hooks", subagents: [], background: 0, compacting: false, since }) as never;
  // Each window has its own hub, writing to main's one ledger, and hears the host's changes a
  // moment after the other: the host's time for each change is the same in both.
  const windows = [0, 700].map((late) => {
    const timers: Array<() => void> = [];
    const hub = new ViewEventHub({ now: () => clock + late, schedule: (fn) => { timers.push(fn); }, ledger: (lines) => ledger.append(lines) });
    hub.setWorkspace("ws", ["claude", "aider"].map((id) => ({ id, frameId: null, kind: "agent", name: id })));
    return { hub, last: new Map(), flush: () => { while (timers.length) timers.shift()!(); } };
  });
  for (const w of windows) {
    // aider has no turn hook: its turn is the working → idle the host read off its screen.
    w.hub.onStatus({ tileId: "aider", label: "aider", status: "working", since: at(1) });
    w.hub.onStatus({ tileId: "aider", label: "aider", status: "idle", since: at(4, 30) });
    // claude's hook ended its turn.
    feedHostedStatus(w.hub, w.last, { seq: 1, tileId: "claude", status: hooked("working", at(2)) });
    feedHostedStatus(w.hub, w.last, { seq: 2, tileId: "claude", status: hooked("done", at(5)) });
  }
  // The windows flush their lines every few seconds, each on its own clock.
  clock = at(6);
  for (const w of windows) w.flush();
  clock = at(10);
  const turns = Object.fromEntries(ledger.history("ws", "2026-09-23").tiles.map((t) => [t.id, t.turns]));
  assert.deepEqual(turns, { claude: [at(5)], aider: [at(4, 30)] });
});
