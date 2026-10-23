/**
 * The notice desk's decisions, Electron-free (notice-desk.ts wires them to the windows, the OS
 * pop-up and the player). Every window sends main each agent change that matters (`notify:agent`:
 * needs you, finished, failed); with two windows open each change arrives twice, and a workflow's
 * ten agents finish together. The desk:
 *
 *  1. dedupes: the first notice for (tile, kind) in DEDUPE_MS is an event, and later copies only
 *     merge into it (`selected ||= copy.selected`);
 *  2. gates the OS pop-up on that event, and groups a burst: the first pop-up of a kind shows at
 *     once, the rest within GROUP_MS gather into one ("9 more agents finished"), and needs you is
 *     never folded into finished (each kind groups on its own);
 *  3. decides a sound (`shouldNotify(s, kind, "sound")`): a finished sound is skipped while the
 *     person looks at that tile (selected in the focused window); needs you always plays, DND
 *     never mutes it;
 *  4. paces sounds: an offer waits GATHER_MS so copies and a burst gather, the highest pending
 *     moment wins (needs > failed > finished) with how many agents it stands for, at most one
 *     sound every SOUND_GAP_MS, and the rest are dropped, not queued;
 *  5. keeps the last RECENT_MAX bursts for Settings and the CLI: the moment, how many agents, when,
 *     the sound (played, blocked and why, skipped, or off) and how many pop-ups it showed.
 *
 * Per notice: one Map get and set, an array push, and at most one timer per pacer or group. The
 * dedupe map is pruned from its oldest end on each admit and capped at DEDUPE_MAX, so nothing
 * rescans. `now` and `schedule` are given, as `CommunityLink` takes them.
 */
import type { AgentNotice } from "../shared/ipc.js";
import { shouldNotify, type NoticeKind, type NotificationSettings } from "../shared/notification-settings.js";
import { lineFor, type AgentWait } from "../shared/line-for.js";
import { toBareId } from "@hivemind/workspace-api/tile-id";

export const DEDUPE_MS = 2000;
export const DEDUPE_MAX = 1024;
export const GATHER_MS = 150;
export const SOUND_GAP_MS = 1200;
export const GROUP_MS = 1500;
export const RECENT_MAX = 10;

const RANK: Record<NoticeKind, number> = { needs: 3, error: 2, done: 1 };

export interface Clock {
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
}

/** A notice the desk let through: the first of its copies. */
export interface Admitted {
  notice: AgentNotice;
  at: number;
  /** The tile is selected in the focused window, as this copy or a later one said. */
  selected: boolean;
  /** The burst it is counted in. */
  burst?: Burst;
}

/** What Recent shows of one burst of one kind. */
export interface Burst {
  id: number;
  moment: NoticeKind;
  /** How many agents. */
  agents: number;
  /** When it started (ms since the epoch). */
  at: number;
  /** How many OS pop-ups it showed. */
  popups: number;
  /** off: no sound for this moment; waiting: offered; skipped: another sound or the person's look
   *  took its place; played or blocked: what the window that played it said. */
  sound: "off" | "waiting" | "skipped" | "played" | "blocked";
  /** Why it was skipped or blocked. */
  why?: string;
  /** The theme's sound pack that played, by name; none: the built-in sound. */
  pack?: string;
  /** How many agents the sound played stood for. */
  count?: number;
}

/** A sound for a window to play. */
export interface Sound { id: number; moment: NoticeKind; count: number }

/** An OS pop-up to show: one agent, or a gathered group (`more`), whose click goes to the first. */
export interface Popup { kind: NoticeKind; notices: AgentNotice[]; more: boolean; silent: boolean }

/** Dedupes the copies each window sends of one change. */
export class NoticeDesk {
  private readonly seen = new Map<string, Admitted>();
  constructor(private readonly clock: Pick<Clock, "now">) {}

  /** The event for `n`, or null when it is a copy of one in the last DEDUPE_MS (merged into it). */
  admit(n: AgentNotice, selected: boolean): Admitted | null {
    const now = this.clock.now();
    // Insertion order is age order (a re-admit deletes first), so the expired are at the front.
    for (const [key, a] of this.seen) {
      if (now - a.at < DEDUPE_MS) break;
      this.seen.delete(key);
    }
    const key = `${n.tileId}\u0000${n.kind}`;
    const was = this.seen.get(key);
    if (was) {
      this.merge(was, selected);
      return null;
    }
    const a: Admitted = { notice: n, at: now, selected };
    this.seen.set(key, a);
    if (this.seen.size > DEDUPE_MAX) this.seen.delete(this.seen.keys().next().value!);
    return a;
  }

  merge(a: Admitted, selected: boolean): void {
    a.selected ||= selected;
  }

  get size(): number { return this.seen.size; }
}

/** Gathers sound offers and lets one through at a time. */
export class SoundPacer {
  private pending: Admitted[] = [];
  private dueAt: number | null = null;
  private last = Number.NEGATIVE_INFINITY;
  constructor(private readonly clock: Clock, private readonly fire: (moment: NoticeKind, carried: Admitted[], dropped: Admitted[]) => void) {}

  offer(a: Admitted): void {
    this.pending.push(a);
    if (this.dueAt !== null) return;
    const now = this.clock.now();
    this.dueAt = Math.max(now + GATHER_MS, this.last + SOUND_GAP_MS);
    this.clock.schedule(() => this.due(), this.dueAt - now);
  }

  /** Play the highest moment gathered, for every agent of it; drop the rest. */
  due(): void {
    const all = this.pending;
    this.pending = [];
    this.dueAt = null;
    let moment: NoticeKind | null = null;
    for (const a of all) if (!looking(a) && (!moment || RANK[a.notice.kind] > RANK[moment])) moment = a.notice.kind;
    if (!moment) return void this.fire("done", [], all);
    this.last = this.clock.now();
    this.fire(moment, all.filter((a) => a.notice.kind === moment && !looking(a)), all.filter((a) => a.notice.kind !== moment || looking(a)));
  }
}

/** The person looks at the tile that finished: no sound for it. */
const looking = (a: Admitted) => a.notice.kind === "done" && a.selected;

/** Shows the first pop-up of a kind at once and gathers the rest of its burst into one. */
export class PopupGrouper {
  private readonly open = new Map<NoticeKind, Admitted[]>();
  constructor(private readonly clock: Clock, private readonly show: (kind: NoticeKind, group: Admitted[], more: boolean) => void) {}

  offer(a: Admitted): void {
    const kind = a.notice.kind;
    const gathered = this.open.get(kind);
    if (gathered) return void gathered.push(a);
    this.open.set(kind, []);
    this.show(kind, [a], false);
    this.clock.schedule(() => {
      const group = this.open.get(kind) ?? [];
      this.open.delete(kind);
      if (group.length) this.show(kind, group, true);
    }, GROUP_MS);
  }
}

export interface DeskDeps extends Clock {
  settings(): NotificationSettings;
  /** Whether an app window has the focus: the window already shows it, so no OS pop-up. */
  focused(): boolean;
  popup(p: Popup): void;
  sound(s: Sound): void;
}

/** The desk: dedupe, pop-ups, sounds and Recent, in one place. */
export class NoticeDeskCore {
  private readonly desk: NoticeDesk;
  private readonly pacer: SoundPacer;
  private readonly grouper: PopupGrouper;
  /** Newest last; at most RECENT_MAX. */
  private readonly bursts: Burst[] = [];
  /** The open burst of each kind: the last notice of it came under GROUP_MS ago. */
  private readonly openBurst = new Map<NoticeKind, { burst: Burst; last: number }>();
  private readonly playing = new Map<number, Burst>();
  private ids = 0;

  constructor(private readonly deps: DeskDeps) {
    this.desk = new NoticeDesk(deps);
    this.pacer = new SoundPacer(deps, (moment, carried, dropped) => this.fired(moment, carried, dropped));
    this.grouper = new PopupGrouper(deps, (kind, group, more) => {
      if (more && this.deps.focused()) return;
      for (const b of new Set(group.map((a) => a.burst!))) b.popups++;
      this.deps.popup({ kind, notices: group.map((a) => a.notice), more, silent: shouldNotify(this.deps.settings(), kind, "sound", this.deps.now()) });
    });
  }

  /** A window's notice; `selected`: its tile is selected in that window, and that window has the focus. */
  receive(n: AgentNotice, selected: boolean): void {
    const a = this.desk.admit(n, selected);
    if (!a) return;
    const s = this.deps.settings();
    const now = this.deps.now();
    const kind = n.kind;
    const sound = shouldNotify(s, kind, "sound", now);
    a.burst = this.burstFor(kind, now, sound);
    a.burst.agents++;
    if (!this.deps.focused() && shouldNotify(s, kind, "osPopups", now)) this.grouper.offer(a);
    if (sound) this.pacer.offer(a);
  }

  /** What the window said of sound `id`. */
  result(id: number, played: boolean, why?: string, pack?: string): void {
    const b = this.playing.get(id);
    if (!b) return;
    this.playing.delete(id);
    b.sound = played ? "played" : "blocked";
    if (why) b.why = why;
    if (pack) b.pack = pack;
  }

  /** The last RECENT_MAX bursts, newest first, as copies. */
  recent(): Burst[] {
    return this.bursts.map((b) => ({ ...b })).reverse();
  }

  /** A sound asked for by name (Settings' Play, `hive notifications play`): no gate, no pacing.
   *  `asking` hears its id before it is sent, so an answer that comes at once finds who asked. */
  play(moment: NoticeKind, asking?: (s: Sound) => void): Sound {
    const b = this.newBurst(moment, this.deps.now(), "waiting");
    const sound = { id: b.id, moment, count: 1 };
    b.count = 1;
    this.playing.set(b.id, b);
    asking?.(sound);
    this.deps.sound(sound);
    return sound;
  }

  private burstFor(kind: NoticeKind, now: number, sound: boolean): Burst {
    const open = this.openBurst.get(kind);
    if (open && now - open.last < GROUP_MS && this.bursts.includes(open.burst)) {
      open.last = now;
      return open.burst;
    }
    const burst = this.newBurst(kind, now, sound ? "waiting" : "off");
    this.openBurst.set(kind, { burst, last: now });
    return burst;
  }

  private newBurst(moment: NoticeKind, at: number, sound: Burst["sound"]): Burst {
    const burst: Burst = { id: ++this.ids, moment, agents: 0, at, popups: 0, sound };
    this.bursts.push(burst);
    if (this.bursts.length > RECENT_MAX) {
      const gone = this.bursts.shift()!;
      this.playing.delete(gone.id);
    }
    return burst;
  }

  private fired(moment: NoticeKind, carried: Admitted[], dropped: Admitted[]): void {
    for (const a of dropped) {
      const b = a.burst!;
      if (b.sound !== "waiting" || carried.some((c) => c.burst === b)) continue;
      b.sound = "skipped";
      b.why = looking(a) ? "you were looking at it" : `the ${moment === "needs" ? "needs you" : moment === "error" ? "failed" : "finished"} sound played instead`;
    }
    if (!carried.length) return;
    const b = carried[0]!.burst!;
    b.count = carried.length;
    this.playing.set(b.id, b);
    this.deps.sound({ id: b.id, moment, count: carried.length });
  }
}

/** How long a pop-up with text waits for the feed to bring what an agent waits on: its status
 *  changes at once, its wait up to 250 ms later (agent-feed.ts). */
export const WAIT_FOR_WAIT_MS = 1000;
const WAIT_STEP_MS = 250;

/**
 * What one agent's pop-up says under its name when the person turned that on (`popupText`), else
 * nothing: for needs you, what it waits on (asked again every 250 ms for up to WAIT_FOR_WAIT_MS);
 * for finished or failed, its tile's last line. One line of plain text (`lineFor`), never for a
 * gathered pop-up, and never anywhere but this pop-up: push carries no text.
 */
export async function popupTextOf(
  p: Popup,
  on: boolean,
  o: { waitingOf(bare: string): AgentWait | undefined; lineOf(bare: string): string | undefined; sleep(ms: number): Promise<unknown> },
): Promise<string | undefined> {
  const first = p.notices[0];
  if (!on || p.more || !first) return undefined;
  const bare = toBareId(first.tileId);
  if (p.kind !== "needs") return lineFor(undefined, o.lineOf(bare)) || undefined;
  for (let waited = 0; ; waited += WAIT_STEP_MS) {
    const w = o.waitingOf(bare);
    if (w) return lineFor(w, undefined) || undefined;
    if (waited >= WAIT_FOR_WAIT_MS) return undefined;
    await o.sleep(WAIT_STEP_MS);
  }
}
