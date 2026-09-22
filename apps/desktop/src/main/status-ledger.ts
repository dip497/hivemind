/**
 * The status ledger (protocol 1.3 history): one append-only JSONL file per local day of what the
 * host observed — status buckets, tile open/close, turns — plus a small file of presence totals.
 * Time the host did not watch is a gap, never idle. Folding a day into intervals happens here, so
 * the renderer never parses a file.
 */
import fs from "node:fs";
import path from "node:path";
import type { ViewHistoryDay, ViewHistoryTile, ViewStatus } from "@hivemind/view-sdk/protocol";
import type { LedgerSince } from "../shared/ipc.js";
import { localDay, nextMidnight, type PresenceTotals } from "./presence.js";

export const HEARTBEAT_MS = 5 * 60 * 1000;
/** A span shorter than a heartbeat plus slack between two lines is still "watched". */
const GRACE_MS = HEARTBEAT_MS + 60 * 1000;
export const RETENTION_DAYS = 30;
export const MAX_INTERVALS = 20_000;
const FLICKER_MS = 1000;
const STATUSES: readonly ViewStatus[] = ["unknown", "idle", "working", "blocked", "exited"];

interface Info { f: string | null; ft?: string; tk: string; a?: string; n: string }
type Line =
  | { t: number; e: "b" | "h" | "x" }
  | { t: number; e: "S"; k: string; tiles: Array<{ id: string; s?: ViewStatus; u?: boolean } & Info> }
  | { t: number; k: string; e: "s"; id: string; s: ViewStatus; x?: boolean }
  | ({ t: number; k: string; e: "o" | "i"; id: string } & Info)
  | { t: number; k: string; e: "c"; id: string; n: string }
  | { t: number; k: string; e: "t"; id: string }
  | { t: number; k: string; e: "u"; id: string; on: boolean };

interface Live { s?: ViewStatus; since?: number; exact?: boolean; info?: Info; u?: boolean }

const str = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v: unknown, max = 256) => v === undefined || (typeof v === "string" && v.length <= max);

/** A line from the renderer, or null. Main's own lines never pass through here. */
export function parseRendererLine(raw: unknown): Line | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.t !== "number" || !Number.isFinite(l.t) || !str(l.k, 1024) || !str(l.id)) return null;
  switch (l.e) {
    case "s": return STATUSES.includes(l.s as ViewStatus) ? { t: l.t, k: l.k, e: "s", id: l.id, s: l.s as ViewStatus, x: l.x === true } : null;
    case "o": case "i":
      if (!(l.f === null || str(l.f)) || !str(l.tk, 64) || typeof l.n !== "string" || !optStr(l.ft) || !optStr(l.a, 64)) return null;
      return { t: l.t, k: l.k, e: l.e, id: l.id, f: l.f as string | null, tk: l.tk, n: (l.n as string).slice(0, 256), ...(l.ft ? { ft: l.ft as string } : {}), ...(l.a ? { a: l.a as string } : {}) };
    case "c": return typeof l.n === "string" ? { t: l.t, k: l.k, e: "c", id: l.id, n: l.n.slice(0, 256) } : null;
    case "t": return { t: l.t, k: l.k, e: "t", id: l.id };
    case "u": return typeof l.on === "boolean" ? { t: l.t, k: l.k, e: "u", id: l.id, on: l.on } : null;
    default: return null;
  }
}

export function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
}

export class StatusLedger {
  private live = new Map<string, Map<string, Live>>();
  private lastWriteT = 0;
  private lastDay: string | null = null;
  private readonly now: () => number;

  constructor(private dir: string, now?: () => number) { this.now = now ?? (() => Date.now()); }

  boot(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.prune();
    this.write([{ t: this.now(), e: "b" }]);
  }

  stop(): void { this.write([{ t: this.now(), e: "x" }]); }

  /** Write a heartbeat when nothing else was written for a while, so a crash is bounded. */
  heartbeat(): void {
    const t = this.now();
    if (t - this.lastWriteT >= HEARTBEAT_MS - 1000 || (this.lastDay && localDay(t) !== this.lastDay)) this.write([{ t, e: "h" }]);
  }

  append(raw: unknown[]): void {
    const lines: Line[] = [];
    for (const r of raw) { const l = parseRendererLine(r); if (l) lines.push(l); }
    for (const l of lines) this.track(l);
    this.write(lines);
  }

  /** Where each tile's current status began, for a renderer that just (re)loaded. */
  snapshot(): LedgerSince[] {
    const out: LedgerSince[] = [];
    for (const tiles of this.live.values()) for (const [id, v] of tiles) {
      if (v.s && v.since !== undefined) out.push({ id, bucket: v.s, since: v.since, exact: !!v.exact });
    }
    return out;
  }

  setPresenceTotals(day: string, totals: PresenceTotals): void {
    try { fs.writeFileSync(path.join(this.dir, `${day}.presence.json`), JSON.stringify(roundTotals(totals)), { mode: 0o600 }); } catch { /* best-effort */ }
  }

  history(layoutKey: string, day: string): ViewHistoryDay {
    const from = dayStart(day);
    const to = nextMidnight(from);
    const now = this.now();
    const result: ViewHistoryDay = { day, from, to, tiles: [], frames: {}, presence: this.presence(day), gaps: [] };
    if (from > now) return result;
    const lines = this.read(day).sort((a, b) => a.t - b.t);
    if (lines.length === 0) { result.gaps.push({ from, to: Math.min(to, now) }); return result; }

    interface T { info?: Info; cur?: { s: ViewStatus; start: number }; unwatchedSince?: number; out: ViewHistoryTile }
    const tiles = new Map<string, T>();
    const tile = (id: string): T => {
      let x = tiles.get(id);
      if (!x) { x = { out: { id, frameId: null, tileKind: "unknown", name: id, intervals: [], turns: [] } }; tiles.set(id, x); }
      return x;
    };
    const close = (x: T, at: number) => {
      if (x.cur && at > x.cur.start) x.out.intervals.push([x.cur.start, at, x.cur.s]);
      x.cur = undefined;
    };
    const closeAll = (at: number) => { for (const x of tiles.values()) { close(x, at); if (x.unwatchedSince !== undefined) { result.gaps.push({ from: x.unwatchedSince, to: at, tileId: x.out.id }); x.unwatchedSince = undefined; } } };
    const setInfo = (x: T, i: Info) => {
      x.info = i;
      Object.assign(x.out, { frameId: i.f, tileKind: i.tk, name: i.n, ...(i.a ? { agent: i.a } : {}) });
      if (i.f && i.ft) result.frames[i.f] = i.ft;
    };

    let watching = false;
    let lastT = from;
    const first = lines[0]!;
    if (first.e === "S" && first.t - from <= GRACE_MS) watching = true;
    else if (first.t > from) result.gaps.push({ from, to: first.t });

    for (const l of lines) {
      const t = Math.max(l.t, from);
      switch (l.e) {
        case "b":
          if (watching) { closeAll(lastT); if (t > lastT) result.gaps.push({ from: lastT, to: t }); }
          watching = true;
          break;
        case "x": closeAll(t); watching = false; break;
        case "h": break;
        case "S":
          watching = true;
          if (l.k !== layoutKey) break;
          for (const s of l.tiles) {
            const x = tile(s.id);
            setInfo(x, s);
            if (s.u) x.unwatchedSince = from;
            else if (s.s) x.cur = { s: s.s, start: from };
          }
          break;
        default: {
          if (l.k !== layoutKey) break;
          const x = tile(l.id);
          if (l.e === "i" || l.e === "o") { setInfo(x, l); if (l.e === "o") x.out.openedAt = t; }
          else if (l.e === "s") { close(x, t); if (x.unwatchedSince === undefined) x.cur = { s: l.s, start: t }; }
          else if (l.e === "c") { close(x, t); x.out.closedAt = t; x.out.name = l.n; }
          else if (l.e === "t") x.out.turns.push(t);
          else if (l.e === "u") {
            if (l.on) { close(x, t); x.unwatchedSince ??= t; }
            else if (x.unwatchedSince !== undefined) { result.gaps.push({ from: x.unwatchedSince, to: t, tileId: l.id }); x.unwatchedSince = undefined; }
          }
        }
      }
      if (l.e !== "x") lastT = Math.max(lastT, t);
      else lastT = t;
    }

    const end = Math.min(to, now);
    if (watching) {
      // A day that ended while the app ran: the next day's file opens with the carried state.
      const stillRunning = end === to ? to - lastT <= GRACE_MS || this.read(localDay(to))[0]?.e === "S" : now - lastT <= GRACE_MS;
      const closeAt = stillRunning ? end : lastT;
      closeAll(closeAt);
      if (closeAt < end) result.gaps.push({ from: closeAt, to: end });
    } else if (lastT < end) result.gaps.push({ from: lastT, to: end });

    let total = 0;
    for (const x of tiles.values()) { x.out.intervals = mergeFlickers(x.out.intervals); total += x.out.intervals.length; result.tiles.push(x.out); }
    if (total > MAX_INTERVALS) {
      const cutoff = result.tiles.flatMap((x) => x.intervals.map((i) => i[0])).sort((a, b) => b - a)[MAX_INTERVALS - 1]!;
      for (const x of result.tiles) x.intervals = x.intervals.filter((i) => i[0] >= cutoff).slice(-MAX_INTERVALS);
    }
    result.gaps.sort((a, b) => a.from - b.from);
    return result;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private track(l: Line): void {
    if (!("id" in l)) return;
    let tiles = this.live.get(l.k);
    if (!tiles) this.live.set(l.k, (tiles = new Map()));
    const v = tiles.get(l.id) ?? {};
    if (l.e === "c") { tiles.delete(l.id); return; }
    if (l.e === "s") { v.s = l.s; v.since = l.t; v.exact = !!l.x; }
    else if (l.e === "i" || l.e === "o") v.info = { f: l.f, ...(l.ft ? { ft: l.ft } : {}), tk: l.tk, ...(l.a ? { a: l.a } : {}), n: l.n };
    else if (l.e === "u") v.u = l.on;
    tiles.set(l.id, v);
  }

  private write(lines: Line[]): void {
    if (lines.length === 0) return;
    const byDay = new Map<string, Line[]>();
    for (const l of lines) {
      const day = localDay(l.t);
      if (this.lastDay && day > this.lastDay) {
        // A new day's file starts with the state that carried over midnight, so each file stands alone.
        const t = Math.max(dayStart(day), this.lastWriteT);
        const carry = [...this.live].map(([k, tiles]) => ({
          t, e: "S" as const, k,
          tiles: [...tiles].filter(([, v]) => v.info).map(([id, v]) => ({ id, ...v.info!, ...(v.s ? { s: v.s } : {}), ...(v.u ? { u: true } : {}) })),
        }));
        byDay.set(day, [...(byDay.get(day) ?? []), ...carry]);
      }
      if (!this.lastDay || day > this.lastDay) this.lastDay = day;
      byDay.set(day, [...(byDay.get(day) ?? []), l]);
      this.lastWriteT = Math.max(this.lastWriteT, l.t);
    }
    for (const [day, ls] of byDay) {
      try { fs.appendFileSync(path.join(this.dir, `${day}.jsonl`), ls.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 }); } catch { /* best-effort */ }
    }
  }

  private read(day: string): Line[] {
    let text = "";
    try { text = fs.readFileSync(path.join(this.dir, `${day}.jsonl`), "utf8"); } catch { return []; }
    const out: Line[] = [];
    for (const s of text.split("\n")) {
      if (!s) continue;
      try { const l = JSON.parse(s) as Line; if (typeof l.t === "number" && typeof l.e === "string") out.push(l); } catch { /* a torn last line after a crash */ }
    }
    return out;
  }

  private presence(day: string): PresenceTotals {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(this.dir, `${day}.presence.json`), "utf8")) as Partial<PresenceTotals>;
      return { active: Number(p.active) || 0, idle: Number(p.idle) || 0, away: Number(p.away) || 0 };
    } catch { return { active: 0, idle: 0, away: 0 }; }
  }

  private prune(): void {
    const keep = localDay(this.now() - RETENTION_DAYS * 86_400_000);
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const n of names) {
      const m = /^(\d{4}-\d{2}-\d{2})\.(jsonl|presence\.json)$/.exec(n);
      if (m && m[1]! < keep) { try { fs.unlinkSync(path.join(this.dir, n)); } catch { /* ignore */ } }
    }
  }
}

function roundTotals(t: PresenceTotals): PresenceTotals {
  return { active: Math.round(t.active), idle: Math.round(t.idle), away: Math.round(t.away) };
}

/** Drop sub-second spans and join the neighbours they split. */
export function mergeFlickers(intervals: [number, number, ViewStatus][]): [number, number, ViewStatus][] {
  const out: [number, number, ViewStatus][] = [];
  for (const i of intervals) {
    if (i[1] - i[0] < FLICKER_MS) continue;
    const prev = out.at(-1);
    if (prev && prev[2] === i[2] && i[0] - prev[1] < FLICKER_MS) prev[1] = i[1];
    else out.push([i[0], i[1], i[2]]);
  }
  return out;
}
