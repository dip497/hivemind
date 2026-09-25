/**
 * view-events — the app-wide source of what protocol 1.3 tells views: when each tile's status
 * began (`since`), discrete events (turns, needs-input, subagents, open/close, custom), a
 * replay ring for views that mount late, and the lines the status ledger in main records.
 *
 * It runs whatever view is active (terminals stay mounted in the TileHost), so a view that
 * mounts late still learns the truth. Pure: time, timers and the ledger sink are injected.
 */
import type { JsonValue, NeedsInputReason, TurnOutcome, ViewEvent, ViewStatus } from "@hivemind/view-sdk/protocol";
import type { StatusEvent, TileStatusKind } from "../agent-status-bus";
import { bucketTileStatus } from "./tile-status-bucket";

export interface HubTile {
  id: string;
  frameId: string | null;
  frameTitle?: string;
  kind: string;
  agent?: string;
  /** The user's rename, else the tile's own label — never an agent-set title. */
  name: string;
  /** Its machine's link is not online, so nothing here is watching it. */
  unwatched?: boolean;
}

export interface SinceInfo { bucket: ViewStatus; since: number; exact: boolean }

/** One ledger line. `k` is the workspace's layout key. */
export type LedgerLine =
  | { t: number; k: string; e: "s"; id: string; s: ViewStatus; x: boolean }
  | { t: number; k: string; e: "o" | "i"; id: string; f: string | null; ft?: string; tk: string; a?: string; n: string }
  | { t: number; k: string; e: "c"; id: string; n: string }
  | { t: number; k: string; e: "t"; id: string }
  | { t: number; k: string; e: "u"; id: string; on: boolean };

/** `target`: the only view this event is for (`hive ctl view emit --view`), if any. */
type Listener = (e: ViewEvent, target?: string) => boolean;

export const RING_MAX = 256;
export const RING_MAX_AGE_MS = 60 * 60 * 1000;
export const REPLAY_MAX = 100;
export const SUBAGENT_COALESCE_MS = 250;
export const LEDGER_FLUSH_MS = 5000;

const REASON: Partial<Record<TileStatusKind, NeedsInputReason>> = {
  permission: "permission", question: "question", plan_review: "review", awaiting_approval: "approval", blocked: "input",
};

export interface HubDeps {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Receives ledger lines in batches. */
  ledger?: (lines: LedgerLine[]) => void;
  /** Tile kinds that are agents (inferred turns apply only to them). */
  isAgentKind?: (kind: string) => boolean;
}

export class ViewEventHub {
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private sinceMap = new Map<string, SinceInfo>();
  private seeds = new Map<string, SinceInfo>();
  private raw = new Map<string, TileStatusKind>();
  private tiles = new Map<string, HubTile>();
  private layoutKey: string | null = null;
  private initialized = false;
  private openedThisRun = new Set<string>();
  private hookTurns = new Set<string>();
  private failed = new Set<string>();
  private subagents = new Map<string, number>();
  private subagentPending = new Map<string, number>();
  private listeners = new Set<Listener>();
  private ring: Array<{ event: ViewEvent; target?: string }> = [];
  private seq = 0;
  private customSeq = 0;
  private pendingLines: LedgerLine[] = [];
  private ledgerTimer = false;

  constructor(private deps: HubDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  // ── inputs ─────────────────────────────────────────────────────────────────

  /** Every effective status the bus emits. */
  onStatus(e: StatusEvent): void {
    const t = this.now();
    const prevRaw = this.raw.get(e.tileId);
    this.raw.set(e.tileId, e.status);
    if (e.status === "exited" && e.exitCode) this.failed.add(e.tileId);
    const reason = REASON[e.status];
    if (reason && prevRaw !== e.status) this.emit({ kind: "needsInput", tileId: e.tileId, reason }, t);

    const bucket = bucketTileStatus(e.status);
    const cur = this.sinceMap.get(e.tileId);
    if (cur?.bucket === bucket) return;
    if (cur?.bucket === "working" && bucket === "idle" && !e.synthetic && !this.hookTurns.has(e.tileId) && this.isAgent(e.tileId)) {
      this.emit({ kind: "turn", tileId: e.tileId, inferred: true }, t);
    }
    let next: SinceInfo;
    if (cur) next = { bucket, since: t, exact: true };
    else {
      const seed = this.seeds.get(e.tileId);
      this.seeds.delete(e.tileId);
      next = seed?.bucket === bucket ? seed : { bucket, since: t, exact: this.openedThisRun.has(e.tileId) };
    }
    this.sinceMap.set(e.tileId, next);
    this.line({ t: next.since, e: "s", id: e.tileId, s: bucket, x: next.exact });
  }

  /** What main remembered before this renderer loaded (a reload keeps exact times). */
  seed(entries: Array<{ id: string } & SinceInfo>): void {
    for (const s of entries) {
      const cur = this.sinceMap.get(s.id);
      if (!cur) this.seeds.set(s.id, { bucket: s.bucket, since: s.since, exact: s.exact });
      else if (cur.bucket === s.bucket && !cur.exact && s.since <= cur.since) this.sinceMap.set(s.id, { bucket: s.bucket, since: s.since, exact: s.exact });
    }
  }

  /** The workspace's tiles, on every structural change. */
  setWorkspace(layoutKey: string | null, tiles: HubTile[], spawnLinks: ReadonlyArray<{ parent: string; child: string }> = []): void {
    const t = this.now();
    if (layoutKey !== this.layoutKey) {
      // A different workspace: its tiles were not opened now, they were already there.
      this.layoutKey = layoutKey;
      this.tiles.clear();
      this.initialized = false;
    }
    const next = new Map(tiles.map((x) => [x.id, x]));
    for (const [id, old] of this.tiles) {
      if (next.has(id)) continue;
      const lastStatus = this.sinceMap.get(id)?.bucket ?? "unknown";
      this.emit({ kind: "tileClosed", tileId: id, lastStatus, ...(this.failed.has(id) ? { failed: true } : {}) }, t);
      this.line({ t, e: "c", id, n: old.name });
      this.forget(id);
    }
    const parentOf = new Map(spawnLinks.map((l) => [l.child, l.parent]));
    for (const tile of tiles) {
      const old = this.tiles.get(tile.id);
      if (!old) {
        const info = { f: tile.frameId, ...(tile.frameTitle ? { ft: tile.frameTitle } : {}), tk: tile.kind, ...(tile.agent ? { a: tile.agent } : {}), n: tile.name };
        if (this.initialized) {
          this.openedThisRun.add(tile.id);
          const s = this.sinceMap.get(tile.id);
          if (s && !s.exact) this.sinceMap.set(tile.id, { ...s, exact: true });
          const spawnedBy = parentOf.get(tile.id);
          this.emit({ kind: "tileOpened", tileId: tile.id, frameId: tile.frameId, tileKind: tile.kind, ...(tile.agent ? { agent: tile.agent } : {}), ...(spawnedBy ? { spawnedBy } : {}) }, t);
          this.line({ t, e: "o", id: tile.id, ...info });
        } else {
          this.line({ t, e: "i", id: tile.id, ...info });
          const s = this.sinceMap.get(tile.id);
          if (s) this.line({ t, e: "s", id: tile.id, s: s.bucket, x: s.exact });
        }
      }
      if (!!old?.unwatched !== !!tile.unwatched) {
        this.line({ t, e: "u", id: tile.id, on: !!tile.unwatched });
        const s = this.sinceMap.get(tile.id);
        if (!tile.unwatched && s) this.line({ t, e: "s", id: tile.id, s: s.bucket, x: s.exact });
      }
    }
    this.tiles = next;
    this.initialized = true;
  }

  /** A turn hook fired for this tile, ending the turn this way. */
  onHookTurn(tileId: string, outcome?: TurnOutcome): void {
    this.hookTurns.add(tileId);
    const t = this.now();
    this.emit({ kind: "turn", tileId, ...(outcome ? { outcome } : {}) }, t);
    this.line({ t, e: "t", id: tileId });
  }

  /** The in-flight subagent count changed; bursts coalesce to the last value per window. */
  onSubagents(tileId: string, active: number): void {
    const pending = this.subagentPending.has(tileId);
    this.subagentPending.set(tileId, active);
    if (pending) return;
    this.schedule(() => {
      const n = this.subagentPending.get(tileId) ?? 0;
      this.subagentPending.delete(tileId);
      if ((this.subagents.get(tileId) ?? 0) === n) return;
      this.subagents.set(tileId, n);
      this.emit({ kind: "subagents", tileId, active: n }, this.now());
    }, SUBAGENT_COALESCE_MS);
  }

  /** A `hive ctl view emit`. Returns the event and whether a listening view took it. */
  emitCustom(name: string, data: JsonValue, from: "shell" | { tileId: string }, target?: string): { event: Extract<ViewEvent, { kind: "custom" }>; delivered: boolean } {
    const id = `ev_${this.now().toString(36)}${(++this.customSeq).toString(36)}`;
    const { event, delivered } = this.emit({ kind: "custom", id, name, data, from }, this.now(), target);
    return { event: event as Extract<ViewEvent, { kind: "custom" }>, delivered };
  }

  // ── outputs ────────────────────────────────────────────────────────────────

  sinceOf(tileId: string): SinceInfo | undefined { return this.sinceMap.get(tileId); }

  /** A listener returns whether the event matched what it subscribed to. */
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  /** Buffered events at or after `since` for this view, oldest first, at most REPLAY_MAX after filtering. */
  replay(since: number, accept: (e: ViewEvent) => boolean = () => true, viewId?: string): ViewEvent[] {
    this.trimRing(this.now());
    return this.ring.filter((r) => r.event.at >= since && (!r.target || r.target === viewId) && accept(r.event)).map((r) => r.event).slice(-REPLAY_MAX);
  }

  /** Flush pending ledger lines now (on unload). */
  flushLedger(): void {
    this.ledgerTimer = false;
    if (this.pendingLines.length === 0) return;
    const lines = this.pendingLines;
    this.pendingLines = [];
    this.deps.ledger?.(lines);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private emit(partial: DistributiveOmit<ViewEvent, "seq" | "at">, at: number, target?: string): { event: ViewEvent; delivered: boolean } {
    const event = { ...partial, seq: ++this.seq, at } as ViewEvent;
    this.ring.push(target ? { event, target } : { event });
    this.trimRing(at);
    let delivered = false;
    for (const l of this.listeners) if (l(event, target)) delivered = true;
    return { event, delivered };
  }

  private trimRing(now: number) {
    while (this.ring.length > RING_MAX || (this.ring.length && now - this.ring[0]!.event.at > RING_MAX_AGE_MS)) this.ring.shift();
  }

  private line(l: DistributiveOmit<LedgerLine, "k">) {
    if (!this.layoutKey || !this.deps.ledger) return;
    this.pendingLines.push({ ...l, k: this.layoutKey } as LedgerLine);
    if (this.ledgerTimer) return;
    this.ledgerTimer = true;
    this.schedule(() => this.flushLedger(), LEDGER_FLUSH_MS);
  }

  private isAgent(tileId: string): boolean {
    const t = this.tiles.get(tileId);
    return !!t && (this.deps.isAgentKind?.(t.kind) ?? true);
  }

  private forget(id: string) {
    this.sinceMap.delete(id);
    this.raw.delete(id);
    this.hookTurns.delete(id);
    this.failed.delete(id);
    this.subagents.delete(id);
    this.openedThisRun.delete(id);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
