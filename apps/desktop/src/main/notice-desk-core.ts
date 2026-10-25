/**
 * The notice desk's decisions, Electron-free (notice-desk.ts wires them to the windows, the OS
 * pop-up and the player). Every window sends main each agent change that matters (`notify:agent`:
 * needs you, finished, failed); with two windows open each change arrives twice, and a workflow's
 * ten agents finish together. The desk:
 *
 *  1. dedupes: a notice with the host's `since` is a copy of the last event of its (tile, kind)
 *     when that one had the same `since`, however late it comes, or a later one that came under
 *     LATE_COPY_MS ago: a busy window can see a change seconds after another. `since` is the
 *     host's time of day, so a tile's next session, after the clock was set back, starts lower
 *     than its last; once LATE_COPY_MS have passed it is told. Without `since` (a status only the
 *     window knows), the first notice for (tile, kind) in DEDUPE_MS is the event. A copy only
 *     merges into its event (`selected ||= copy.selected`);
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
 *     the sound (played, blocked and why, skipped, or off), how many agents its sounds stood for,
 *     and how many pop-ups it showed.
 *
 * Per notice: two Map gets and sets, an array push, and at most one timer per pacer or group.
 * The dedupe maps are pruned from their oldest end and capped at DEDUPE_MAX each, so nothing
 * rescans. Every wait is timed on the clock the timers run on (`performance.now()`), so setting the
 * computer's clock back or forward neither holds a sound back nor lets a copy through; the time of
 * day (`Date.now()`) decides Do Not Disturb and is what Recent shows. Both, and `setTimeout`, are
 * the desk's own unless given, as `CommunityLink`'s are; the tests give a clock they move.
 */
import type { AgentNotice } from "../shared/ipc.js";
import { NOTICE_TONES, shouldNotify, type NoticeKind, type NotificationSettings } from "../shared/notification-settings.js";
import { lineFor, type AgentWait } from "../shared/line-for.js";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import type { RecentSound } from "@hivemind/workspace-api/notifications";
import type { AppearanceExtra } from "@hivemind/core/appearance-extra";
import { STATUS_MARKS } from "@hivemind/view-sdk/status";

export const DEDUPE_MS = 2000;
/** How long a copy of an earlier change than the last one told still counts as a copy. */
export const LATE_COPY_MS = 10_000;
export const DEDUPE_MAX = 1024;
export const GATHER_MS = 150;
export const SOUND_GAP_MS = 1200;
export const GROUP_MS = 1500;
export const RECENT_MAX = 10;

const RANK: Record<NoticeKind, number> = { needs: 3, error: 2, done: 1 };

export interface Clock {
  /** Milliseconds on the clock `schedule` runs on, for every wait. */
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

/** What Recent shows of one burst of one kind (the drive socket's shape). */
export type Burst = RecentSound;

/** A sound for a window to play. */
export interface Sound { id: number; moment: NoticeKind; count: number }

/** An OS pop-up to show: one agent, or a gathered group (`more`), whose click goes to the first. */
export interface Popup { kind: NoticeKind; notices: AgentNotice[]; more: boolean; silent: boolean }

/** Dedupes the copies each window sends of one change. */
class NoticeDesk {
  /** The events of the last DEDUPE_MS, oldest first: a copy merges into its event here. */
  private readonly seen = new Map<string, Admitted>();
  /** Each (tile, kind)'s last event's `since`, and when it came, least recently changed first. */
  private readonly since = new Map<string, { since: number; at: number }>();
  constructor(private readonly clock: Pick<Clock, "now">) {}

  /** The event for `n`, or null when it is a copy of one (merged into it, while it is recent). */
  admit(n: AgentNotice, selected: boolean): Admitted | null {
    const now = this.clock.now();
    // Insertion order is age order (a re-admit deletes first), so the expired are at the front.
    for (const [key, a] of this.seen) {
      if (now - a.at < DEDUPE_MS) break;
      this.seen.delete(key);
    }
    const key = `${n.tileId}\u0000${n.kind}`;
    const was = this.seen.get(key);
    const last = this.since.get(key);
    const copy = n.since !== undefined && last !== undefined
      ? n.since === last.since || (n.since < last.since && now - last.at < LATE_COPY_MS)
      : !!was;
    if (copy) {
      if (was) was.selected ||= selected;
      return null;
    }
    const a: Admitted = { notice: n, at: now, selected };
    this.seen.delete(key);
    this.seen.set(key, a);
    if (this.seen.size > DEDUPE_MAX) this.seen.delete(this.seen.keys().next().value!);
    if (n.since !== undefined) {
      this.since.delete(key);
      this.since.set(key, { since: n.since, at: now });
      if (this.since.size > DEDUPE_MAX) this.since.delete(this.since.keys().next().value!);
    }
    return a;
  }
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

export interface DeskDeps extends Partial<Clock> {
  /** The time of day (ms since the epoch): Do Not Disturb, and when a burst started. */
  wall?(): number;
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
  private readonly clock: Clock & { wall(): number };

  constructor(private readonly deps: DeskDeps) {
    this.clock = {
      now: deps.now ?? (() => performance.now()),
      wall: deps.wall ?? (() => Date.now()),
      schedule: deps.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
    };
    this.desk = new NoticeDesk(this.clock);
    this.pacer = new SoundPacer(this.clock, (moment, carried, dropped) => this.fired(moment, carried, dropped));
    this.grouper = new PopupGrouper(this.clock, (kind, group, more) => {
      if (more && this.deps.focused()) return;
      for (const b of new Set(group.map((a) => a.burst!))) b.popups++;
      this.deps.popup({ kind, notices: group.map((a) => a.notice), more, silent: shouldNotify(this.deps.settings(), kind, "sound", this.clock.wall()) });
    });
  }

  /** A window's notice; `selected`: its tile is selected in that window, and that window has the focus. */
  receive(n: AgentNotice, selected: boolean): void {
    const a = this.desk.admit(n, selected);
    if (!a) return;
    const s = this.deps.settings();
    const now = this.clock.now();
    const wall = this.clock.wall();
    const kind = n.kind;
    const sound = shouldNotify(s, kind, "sound", wall);
    a.burst = this.burstFor(kind, now, sound);
    a.burst.agents++;
    if (!this.deps.focused() && shouldNotify(s, kind, "osPopups", wall)) this.grouper.offer(a);
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
    const b = this.newBurst(moment, "waiting");
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
    const burst = this.newBurst(kind, sound ? "waiting" : "off");
    this.openBurst.set(kind, { burst, last: now });
    return burst;
  }

  private newBurst(moment: NoticeKind, sound: Burst["sound"]): Burst {
    const burst: Burst = { id: ++this.ids, moment, agents: 0, at: this.clock.wall(), popups: 0, sound };
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
      b.why = looking(a) ? "you were looking at it" : `the ${STATUS_MARKS[NOTICE_TONES[moment]].word} sound played instead`;
    }
    if (!carried.length) return;
    const b = carried[0]!.burst!;
    // A burst longer than a sound's gather plays again after the gap: count every agent it told.
    b.count = (b.count ?? 0) + carried.length;
    this.playing.set(b.id, b);
    this.deps.sound({ id: b.id, moment, count: carried.length });
  }
}

/**
 * The applied theme's sound for `moment`, and the theme's name: from the settings owner's typed
 * `appearanceExtra.theme` (T3–T4), whose sounds are `hivemedia://media/<file>` URLs only (anything
 * else is dropped on read). None: the built-in sound plays.
 */
export function themeSoundOf(s: { appearanceExtra: Pick<AppearanceExtra, "theme"> }, moment: NoticeKind): { url: string; pack: string } | undefined {
  const theme = s.appearanceExtra.theme;
  const url = theme?.sounds?.[moment];
  if (!theme || !url) return undefined;
  return { url, pack: theme.name.trim().slice(0, 60) || "a theme" };
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
