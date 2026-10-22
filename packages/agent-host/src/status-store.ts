/**
 * Every session's status, in one place: the fold of its canonical events (spec/status.md),
 * plus what the host sees itself — the process ending, the user pressing an interrupt key —
 * and, for an agent that reports nothing, the screen.
 *
 * One authority per session. Until an agent's hooks have spoken, the screen stands in; from
 * the first hook event on, the hooks decide. An agent whose hooks never fire (not installed,
 * or it has none) therefore stays on the screen, and every status says which source it came
 * from. Two exceptions. A turn the hooks call working while the screen shows the agent's own
 * chooser (a model switch, a limit notice) is waiting on the user — no hook reports that —
 * so the screen's reading stands until the screen moves on or a hook speaks again. And a wait
 * ends when the screen moves from a chooser to the agent's prompt: however it was left, the
 * agent waits on nothing (spec/needs.md "Answering").
 *
 * The machine that runs a session is the one that derives its status (docs/design/
 * multiplayer-2026-09-28.md, R6). A session another machine hosts is mirrored: the status is
 * taken as that host has it, and nothing seen here is folded into it, except that it ended and a
 * wait held here (a supervised tool use, a plan), which only this host knows of.
 */
import { INITIAL_STATUS, INPUT_KINDS, SESSION_STATES, foldStatus, type AgentStatus, type InputKind, type SessionState, type StatusInput } from "@hivemind/agents";

export type StatusSource = "hooks" | "screen";

export interface SessionStatus extends AgentStatus {
  source: StatusSource | null;
  /** When `state` last changed (ms since epoch), later than the time before. */
  since: number;
  /** What the agent says it is doing, from its window title; absent when it says nothing. */
  title?: string;
  /** Waiting: what screen it waits on, as its manifest's rule says (`trust`); absent when no
   *  rule says. Read from the screen only. */
  says?: string;
  /** The session it is in, as its hooks last said; kept once it exits, as the one to resume. */
  session?: string;
}

export interface StatusChange {
  seq: number;
  tileId: string;
  status: SessionStatus;
}

/** A screen reading, for agents without hooks. */
export type ScreenState = "idle" | "working" | "permission" | "question" | "blocked";

/** What a session's screen was last read as, and when (ms since epoch). */
export interface ScreenReading {
  state: ScreenState;
  says?: string;
  at: number;
}
const SCREEN_KIND = { permission: "permission", question: "question", blocked: "other" } as const;
const isWait = (s: ScreenState): s is keyof typeof SCREEN_KIND => s !== "idle" && s !== "working";

/** Bytes that interrupt an agent's turn when typed on their own: Esc, Ctrl+C. */
const INTERRUPT_KEYS = new Set(["\x1b", "\x03"]);

/** Keys that answer an agent's own permission prompt: a numbered choice, or Enter on the one
 *  selected. */
const ANSWER_KEY = /^[1-9\r]$/;

/** A status as a host sends it: what a mirror takes, nothing else. */
export function isSessionStatus(x: unknown): x is SessionStatus {
  const s = x as Partial<SessionStatus> | null;
  return typeof s === "object" && s !== null && (SESSION_STATES as readonly unknown[]).includes(s.state)
    && Array.isArray(s.subagents) && s.subagents.every((a) => typeof a === "string")
    && typeof s.background === "number" && typeof s.compacting === "boolean"
    && (s.kind === undefined || (INPUT_KINDS as readonly unknown[]).includes(s.kind))
    && (s.source === null || s.source === "hooks" || s.source === "screen") && typeof s.since === "number"
    && (s.title === undefined || typeof s.title === "string") && (s.says === undefined || typeof s.says === "string")
    && (s.session === undefined || typeof s.session === "string");
}

/** Subagent starts and stops are not a matched pair: a stop is lost when a subagent errors, the
 *  turn is interrupted or the process dies. A set that hears no edge for this long has lost them. */
export const SUBAGENT_GRACE_MS = 120_000;

export class StatusStore {
  private sessions = new Map<string, SessionStatus>();
  /** Sessions another machine hosts, whose status is that host's. */
  private mirrored = new Set<string>();
  /** Each mirrored session's status as its host last sent it, under any wait held here. */
  private hosted = new Map<string, SessionStatus>();
  /** What each session waits on that this host holds the answer to (`waitOn`), and since when. */
  private heldHere = new Map<string, { kind: InputKind; since: number }>();
  /** Sessions whose hook-reported turn the screen is overriding (see the header). */
  private screenHeld = new Set<string>();
  /** Each session's last screen reading, whoever its authority is. */
  private readings = new Map<string, ScreenReading>();
  private seq = 0;
  private listeners = new Set<(c: StatusChange) => void>();
  private screenListeners = new Set<(tileId: string, reading: ScreenReading) => void>();

  /** Each session's pending drain of subagents whose stop never came. */
  private lostStops = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: { now?: () => number; onLostStops?: (tileId: string, count: number) => void } = {}) {}

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  get(tileId: string): SessionStatus | undefined { return this.sessions.get(tileId); }

  /** What the session's screen was last read as; undefined when it never was. */
  reading(tileId: string): ScreenReading | undefined { return this.readings.get(tileId); }

  all(): Array<{ tileId: string; status: SessionStatus }> {
    return [...this.sessions].map(([tileId, status]) => ({ tileId, status }));
  }

  subscribe(fn: (c: StatusChange) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Each screen read, as it is read: what it was read as. */
  onScreen(fn: (tileId: string, reading: ScreenReading) => void): () => void {
    this.screenListeners.add(fn);
    return () => { this.screenListeners.delete(fn); };
  }

  /** A hook reported for this session: the hooks are its authority from now on. A session's
   *  hooks report from its start, so what the screen read before they spoke is not carried over;
   *  but a first hook from inside a turn says the session began before this store did, and a turn
   *  the screen saw running still runs. */
  event(tileId: string, input: StatusInput): void {
    if (this.mirrored.has(tileId)) return;
    const cur = this.sessions.get(tileId);
    const fromScreen = cur?.source !== "hooks" && cur?.state !== "exited";
    this.screenHeld.delete(tileId);
    const session = "event" in input && input.sessionId ? { session: input.sessionId } : {};
    const running = cur?.state === "working" && !("event" in input && input.event.startsWith("session.")) ? { state: "working" as const } : {};
    this.apply(tileId, "hooks", (s) => ({ ...foldStatus(fromScreen ? { ...s, ...INITIAL_STATUS, kind: undefined, ...running } : s, input), ...session }));
    if ("event" in input && (input.event.startsWith("subagent.") || input.event === "turn.ended")) this.watchSubagents(tileId);
  }

  /** Every subagent edge, and a turn's end, push the drain out; a set that empties cancels it. A
   *  subagent still running in the background keeps sending edges, so it is never drained. */
  private watchSubagents(tileId: string): void {
    this.stopWatching(tileId);
    if (!this.sessions.get(tileId)?.subagents.length) return;
    const timer = setTimeout(() => {
      this.lostStops.delete(tileId);
      const left = this.sessions.get(tileId)?.subagents ?? [];
      if (!left.length || this.mirrored.has(tileId)) return;
      this.apply(tileId, "hooks", (s) => ({ ...s, subagents: [] }));
      this.opts.onLostStops?.(tileId, left.length);
    }, SUBAGENT_GRACE_MS);
    timer.unref?.();
    this.lostStops.set(tileId, timer);
  }

  private stopWatching(tileId: string): void {
    const t = this.lostStops.get(tileId);
    if (t !== undefined) clearTimeout(t);
    this.lostStops.delete(tileId);
  }

  /** The screen, read by whoever renders it, and for a wait what screen it says it is: kept as
   *  its last reading; as its status, ignored once the session's hooks have spoken. */
  screen(tileId: string, state: ScreenState, says?: string): void {
    const reading: ScreenReading = { state, ...(says ? { says } : {}), at: this.now() };
    const before = this.readings.get(tileId);
    this.readings.set(tileId, reading);
    if (!this.mirrored.has(tileId)) this.fold(tileId, state, says, before);
    for (const fn of this.screenListeners) fn(tileId, reading);
  }

  private fold(tileId: string, state: ScreenState, says?: string, before?: ScreenReading): void {
    const cur = this.sessions.get(tileId);
    if (cur?.state === "exited") return;
    if (cur?.source === "hooks") {
      const waiting = isWait(state);
      if (this.screenHeld.has(tileId)) {
        // The chooser closed: what the screen shows now is the truth until a hook speaks.
        if (!waiting) this.screenHeld.delete(tileId);
      } else if (cur.state === "waiting" && state === "idle" && before && isWait(before.state)) {
        // Its chooser gave way to its prompt; the prompt alone may be the moment before it is drawn.
      } else if (!(waiting && cur.state === "working")) return;
      else this.screenHeld.add(tileId);
      this.apply(tileId, "hooks", (s) => (waiting ? { ...s, state: "waiting", kind: SCREEN_KIND[state] } : { ...s, state, kind: undefined }), says);
      return;
    }
    this.apply(tileId, "screen", (s) => (state === "idle" || state === "working"
      ? { ...s, state, kind: undefined }
      : { ...s, state: "waiting", kind: SCREEN_KIND[state] }), says);
  }

  /** What the user typed into the session. A lone interrupt key during a turn ends it; a key
   *  that answers the permission it waits on sets it working again, since the agent says
   *  nothing until what was allowed has finished running. */
  input(tileId: string, data: string): void {
    if (this.mirrored.has(tileId)) return;
    const cur = this.sessions.get(tileId);
    if (!cur || cur.source !== "hooks") return;
    if (INTERRUPT_KEYS.has(data)) this.apply(tileId, "hooks", (s) => foldStatus(s, { fact: "interrupt" }));
    else if (cur.state === "waiting" && cur.kind === "permission" && ANSWER_KEY.test(data)) {
      this.screenHeld.delete(tileId);
      this.apply(tileId, "hooks", (s) => foldStatus(s, { event: "input.resolved" }));
    }
  }

  /** The process ended: nothing it was doing is still true. */
  exited(tileId: string): void {
    this.stopWatching(tileId);
    const cur = this.sessions.get(tileId);
    this.apply(tileId, cur?.source ?? null, (s) => ({ ...foldStatus(s, { fact: "exited" }), title: undefined }));
  }

  /** Put to sleep: a turn it was in is interrupted, nothing runs, and it keeps its title. */
  slept(tileId: string): void {
    const cur = this.sessions.get(tileId);
    this.apply(tileId, cur?.source ?? null, (s) => ({ ...foldStatus(s, { fact: "interrupt" }), subagents: [], background: 0, compacting: false }));
  }

  /** The agent's title changed ("" when it says nothing worth a name). Changes no state. */
  title(tileId: string, title: string): void {
    if (this.mirrored.has(tileId)) return;
    const cur = this.sessions.get(tileId);
    if (cur?.state === "exited") return;
    this.apply(tileId, cur?.source ?? null, (s) => ({ ...s, title: title || undefined }), cur?.says);
  }

  /** The session's status as the machine that runs it has it. From now on it is that host's,
   *  but for a wait held here. */
  mirror(tileId: string, status: SessionStatus): void {
    this.mirrored.add(tileId);
    this.hosted.set(tileId, status);
    this.put(tileId, this.withHeldWait(tileId, status));
  }

  /** The session waits on an answer this host holds: its status waits on it until `waitOver`,
   *  whatever its host says meanwhile. */
  waitOn(tileId: string, kind: InputKind): void {
    if (!this.mirrored.has(tileId)) return this.event(tileId, { event: "input.requested", kind });
    const since = Math.max(this.now(), (this.sessions.get(tileId)?.since ?? 0) + 1);
    this.heldHere.set(tileId, { kind, since });
    this.put(tileId, this.withHeldWait(tileId, this.hosted.get(tileId)!));
  }

  /** The wait held here ended: the session's status is what it was without it. */
  waitOver(tileId: string): void {
    if (!this.mirrored.has(tileId)) return this.event(tileId, { event: "input.resolved" });
    const held = this.heldHere.get(tileId);
    this.heldHere.delete(tileId);
    const shown = this.sessions.get(tileId);
    if (!held || shown?.state === "exited") return;
    this.put(tileId, { ...this.hosted.get(tileId)!, since: Math.max(this.now(), held.since + 1) });
  }

  private withHeldWait(tileId: string, status: SessionStatus): SessionStatus {
    const held = this.heldHere.get(tileId);
    if (!held || status.state === "exited") return status;
    const { says: _screen, ...rest } = status;
    return { ...rest, state: "waiting", kind: held.kind, since: held.since };
  }

  forget(tileId: string): void {
    this.stopWatching(tileId);
    this.hosted.delete(tileId);
    this.heldHere.delete(tileId);
    this.sessions.delete(tileId);
    this.readings.delete(tileId);
    this.mirrored.delete(tileId);
    this.screenHeld.delete(tileId);
  }

  /** `says`: what screen it waits on, which only the screen reads, so anything else folded in
   *  clears it. */
  private apply(tileId: string, source: StatusSource | null, fold: (s: AgentStatus) => AgentStatus, says?: string): void {
    const prev = this.sessions.get(tileId);
    const base: AgentStatus = prev ?? INITIAL_STATUS;
    const { says: _was, ...next } = fold(base) as SessionStatus;
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as unknown as AgentStatus;
    const screen = clean.state === "waiting" && says ? { says } : {};
    // Waiting on something else is a new wait, which `since` names: never the one before's, even
    // within a millisecond of it.
    const changed = !prev || prev.state !== clean.state || (clean.state === "waiting" && (prev.kind !== clean.kind || prev.says !== screen.says));
    this.put(tileId, { ...clean, ...screen, source, since: changed ? Math.max(this.now(), (prev?.since ?? 0) + 1) : prev.since });
  }

  private put(tileId: string, status: SessionStatus): void {
    const prev = this.sessions.get(tileId);
    if (prev && sameStatus(prev, status)) return;
    this.sessions.set(tileId, status);
    const change: StatusChange = { seq: ++this.seq, tileId, status };
    for (const fn of this.listeners) fn(change);
  }
}

function sameStatus(a: SessionStatus, b: SessionStatus): boolean {
  return a.state === b.state && a.kind === b.kind && a.says === b.says && a.session === b.session && a.source === b.source && a.background === b.background && a.title === b.title
    && a.compacting === b.compacting && a.subagents.length === b.subagents.length && a.subagents.every((x, i) => x === b.subagents[i]);
}

export type { SessionState };
