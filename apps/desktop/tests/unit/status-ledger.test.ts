import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HEARTBEAT_MS, MAX_INTERVALS, RETENTION_DAYS, StatusLedger, mergeFlickers } from "../../src/main/status-ledger";
import { localDay } from "../../src/main/presence";

const at = (h: number, m = 0, s = 0, day = 23) => new Date(2026, 8, day, h, m, s).getTime();

function harness(start: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  let clock = start;
  const ledger = new StatusLedger(dir, () => clock);
  return { dir, ledger, set: (t: number) => { clock = t; } };
}
const s = (t: number, id: string, st: string, k = "ws") => ({ t, k, e: "s", id, s: st, x: true });
const info = (t: number, id: string, e = "o", k = "ws") => ({ t, k, e, id, f: "f1", ft: "payments", tk: "claude", a: "codex", n: id });

test("a day folds into intervals, turns and frame titles; other workspaces stay out", () => {
  const h = harness(at(9));
  h.ledger.boot();
  h.ledger.append([info(at(9), "a"), s(at(9), "a", "working"), { t: at(9, 30), k: "ws", e: "t", id: "a" }, s(at(9, 30), "a", "blocked"),
    info(at(9), "secret", "o", "other"), s(at(9), "secret", "working", "other")]);
  h.set(at(10));
  h.ledger.append([s(at(10), "a", "idle")]);
  const d = h.ledger.history("ws", "2026-09-23");
  assert.equal(d.tiles.length, 1);
  assert.deepEqual(d.tiles[0]!.intervals, [[at(9), at(9, 30), "working"], [at(9, 30), at(10), "blocked"]]);
  assert.deepEqual(d.tiles[0]!.turns, [at(9, 30)]);
  assert.equal(d.tiles[0]!.agent, "codex");
  assert.deepEqual(d.frames, { f1: "payments" });
  assert.deepEqual(d.gaps, [{ from: at(0), to: at(9) }]); // before the app started
});

test("a crash is a gap bounded by the last line, never idle", () => {
  const h = harness(at(9));
  h.ledger.boot();
  h.ledger.append([info(at(9), "a", "i"), s(at(9), "a", "blocked")]);
  h.set(at(9, 5)); h.ledger.heartbeat();
  // No stop line: the app died. It boots again at 11:00.
  const h2 = new StatusLedger(h.dir, () => at(11));
  h2.boot();
  h2.append([info(at(11), "a", "i"), s(at(11), "a", "blocked")]);
  const d = new StatusLedger(h.dir, () => at(12)).history("ws", "2026-09-23");
  assert.deepEqual(d.tiles[0]!.intervals, [[at(9), at(9, 5), "blocked"]]);
  assert.ok(d.gaps.some((g) => g.from === at(9, 5) && g.to === at(11)), JSON.stringify(d.gaps));
  assert.ok(!d.tiles[0]!.intervals.some(([a, b]) => a < at(11) && b > at(9, 5)), "nothing counted inside the gap");
});

test("a clean stop ends the day's watching until the next boot", () => {
  const h = harness(at(9));
  h.ledger.boot();
  h.ledger.append([info(at(9), "a", "i"), s(at(9), "a", "idle")]);
  h.set(at(10)); h.ledger.stop();
  const d = new StatusLedger(h.dir, () => at(15)).history("ws", "2026-09-23");
  assert.deepEqual(d.tiles[0]!.intervals, [[at(9), at(10), "idle"]]);
  assert.deepEqual(d.gaps.at(-1), { from: at(10), to: at(15) });
});

test("an interval across midnight carries into the next day's file", () => {
  const h = harness(at(23, 50, 0, 22));
  h.ledger.boot();
  h.ledger.append([info(at(23, 50, 0, 22), "a", "i"), s(at(23, 50, 0, 22), "a", "blocked")]);
  h.set(at(0, 4)); h.ledger.heartbeat();
  h.set(at(0, 30));
  h.ledger.append([s(at(0, 30), "a", "idle")]);
  const d = h.ledger.history("ws", "2026-09-23");
  assert.deepEqual(d.tiles[0]!.intervals.slice(0, 1), [[at(0), at(0, 30), "blocked"]]);
  assert.deepEqual(d.gaps, []);
  const prev = h.ledger.history("ws", "2026-09-22");
  assert.deepEqual(prev.tiles[0]!.intervals, [[at(23, 50, 0, 22), at(0), "blocked"]]);
});

test("a DST day is 23 or 25 hours long, and folds without inventing time", () => {
  const h = harness(at(9));
  // 2026-03-08 is a spring-forward day in US zones; in a zone without DST it is simply 24 h.
  const d = h.ledger.history("ws", "2026-03-08");
  const hours = (d.to - d.from) / 3_600_000;
  assert.ok([23, 24, 25].includes(hours), String(hours));
  assert.deepEqual(d.gaps, [{ from: d.from, to: d.to }]);
});

test("a machine that is offline or turned off is a per-tile gap, not a wait", () => {
  const h = harness(at(9));
  h.ledger.boot();
  h.ledger.append([info(at(9), "r", "i"), s(at(9), "r", "blocked"), { t: at(9, 10), k: "ws", e: "u", id: "r", on: true },
    { t: at(9, 40), k: "ws", e: "u", id: "r", on: false }, s(at(9, 40), "r", "blocked")]);
  h.set(at(10));
  h.ledger.heartbeat();
  const d = h.ledger.history("ws", "2026-09-23");
  assert.deepEqual(d.tiles[0]!.intervals, [[at(9), at(9, 10), "blocked"], [at(9, 40), at(10), "blocked"]]);
  assert.ok(d.gaps.some((g) => g.tileId === "r" && g.from === at(9, 10) && g.to === at(9, 40)));
});

test("snapshot seeds a reloaded renderer; closed tiles leave it", () => {
  const h = harness(at(9));
  h.ledger.boot();
  h.ledger.append([info(at(9), "a", "i"), s(at(9, 1), "a", "blocked"), info(at(9), "b", "i"), s(at(9), "b", "idle"), { t: at(9, 2), k: "ws", e: "c", id: "b", n: "b" }]);
  assert.deepEqual(h.ledger.snapshot(), [{ id: "a", bucket: "blocked", since: at(9, 1), exact: true }]);
});

test("renderer lines are validated; junk is dropped, not written", () => {
  const h = harness(at(9));
  h.ledger.boot();
  h.ledger.append([{ t: "x" }, { t: at(9), k: "ws", e: "s", id: "a", s: "purple" }, { t: at(9), k: "ws", e: "rm", id: "a" }, null, s(at(9), "a", "idle")]);
  const text = fs.readFileSync(path.join(h.dir, "2026-09-23.jsonl"), "utf8").trim().split("\n");
  assert.equal(text.length, 2); // boot + the one valid line
});

test("presence is stored as day totals only; old files are pruned at boot", () => {
  const h = harness(at(9));
  const old = localDay(at(9) - (RETENTION_DAYS + 2) * 86_400_000);
  fs.writeFileSync(path.join(h.dir, `${old}.jsonl`), "");
  fs.writeFileSync(path.join(h.dir, `${old}.presence.json`), "{}");
  h.ledger.boot();
  assert.ok(!fs.existsSync(path.join(h.dir, `${old}.jsonl`)));
  h.ledger.setPresenceTotals("2026-09-23", { active: 100.4, idle: 20, away: 3600 });
  assert.deepEqual(h.ledger.history("ws", "2026-09-23").presence, { active: 100, idle: 20, away: 3600 });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(h.dir, "2026-09-23.presence.json"), "utf8"))), ["active", "idle", "away"]);
});

test("flickers merge and the result is capped", () => {
  assert.deepEqual(mergeFlickers([[0, 5000, "working"], [5000, 5300, "idle"], [5300, 9000, "working"]]), [[0, 9000, "working"]]);
  const h = harness(at(9));
  h.ledger.boot();
  const lines = [info(at(9), "a", "i")];
  for (let i = 0; i < MAX_INTERVALS + 50; i++) lines.push(s(at(9) + i * 2000, "a", i % 2 ? "idle" : "working") as never);
  h.ledger.append(lines);
  h.set(at(9) + (MAX_INTERVALS + 50) * 2000 + HEARTBEAT_MS / 2);
  const d = h.ledger.history("ws", "2026-09-23");
  assert.equal(d.tiles[0]!.intervals.length, MAX_INTERVALS);
});
