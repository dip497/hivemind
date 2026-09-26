/**
 * Every session's status, in one place: the fold of its canonical events (spec/status.md),
 * plus what the host sees itself — the process ending, the user pressing an interrupt key —
 * and, for an agent that reports nothing, the screen.
 *
 * One authority per session. Until an agent's hooks have spoken, the screen stands in; from
 * the first hook event on, the hooks alone decide and screen reports are ignored. An agent
 * whose hooks never fire (not installed, or it has none) therefore stays on the screen,
 * and every status says which source it came from.
 */
import { INITIAL_STATUS, foldStatus, type AgentStatus, type SessionState, type StatusInput } from "@hivemind/agents";

export type StatusSource = "hooks" | "screen";

export interface SessionStatus extends AgentStatus {
  source: StatusSource | null;
  /** When `state` last changed (ms since epoch). */
  since: number;
  /** What the agent says it is doing, from its window title; absent when it says nothing. */
  title?: string;
}

export interface StatusChange {
  seq: number;
  tileId: string;
  status: SessionStatus;
}

/** A screen reading, for agents without hooks. */
export type ScreenState = "idle" | "working" | "permission" | "question" | "blocked";
const SCREEN_KIND = { permission: "permission", question: "question", blocked: "other" } as const;

/** Bytes that interrupt an agent's turn when typed on their own: Esc, Ctrl+C. */
const INTERRUPT_KEYS = new Set(["\x1b", "\x03"]);

export class StatusStore {
  private sessions = new Map<string, SessionStatus>();
  private log: StatusChange[] = [];
  private seq = 0;
  private listeners = new Set<(c: StatusChange) => void>();

  constructor(private readonly opts: { now?: () => number; logSize?: number } = {}) {}

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  get(tileId: string): SessionStatus | undefined { return this.sessions.get(tileId); }

  all(): Array<{ tileId: string; status: SessionStatus }> {
    return [...this.sessions].map(([tileId, status]) => ({ tileId, status }));
  }

  /** The last change's sequence number: what a client resumes from. */
  cursor(): number { return this.seq; }

  /** Changes after `seq`, or null when the log no longer reaches back that far — then take `all()`. */
  since(seq: number): StatusChange[] | null {
    if (seq >= this.seq) return [];
    const first = this.log[0]?.seq ?? this.seq + 1;
    if (seq < first - 1) return null;
    return this.log.filter((c) => c.seq > seq);
  }

  subscribe(fn: (c: StatusChange) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** A hook reported for this session: the hooks are its authority from now on. They report
   *  from the session's start, so what the screen read before they spoke is not carried over. */
  event(tileId: string, input: StatusInput): void {
    const cur = this.sessions.get(tileId);
    const fromScreen = cur?.source !== "hooks" && cur?.state !== "exited";
    this.apply(tileId, "hooks", (s) => foldStatus(fromScreen ? { ...s, ...INITIAL_STATUS, kind: undefined } : s, input));
  }

  /** The screen, read by whoever renders it. Ignored once the session's hooks have spoken. */
  screen(tileId: string, state: ScreenState): void {
    const cur = this.sessions.get(tileId);
    if (cur?.source === "hooks" || cur?.state === "exited") return;
    this.apply(tileId, "screen", (s) => (state === "idle" || state === "working"
      ? { ...s, state, kind: undefined }
      : { ...s, state: "waiting", kind: SCREEN_KIND[state] }));
  }

  /** What the user typed into the session. A lone interrupt key during a turn ends it. */
  input(tileId: string, data: string): void {
    const cur = this.sessions.get(tileId);
    if (!cur || cur.source !== "hooks" || !INTERRUPT_KEYS.has(data)) return;
    this.apply(tileId, "hooks", (s) => foldStatus(s, { fact: "interrupt" }));
  }

  /** The process ended: nothing it was doing is still true. */
  exited(tileId: string): void {
    const cur = this.sessions.get(tileId);
    this.apply(tileId, cur?.source ?? null, (s) => ({ ...foldStatus(s, { fact: "exited" }), title: undefined }));
  }

  /** The agent's title changed ("" when it says nothing worth a name). Changes no state. */
  title(tileId: string, title: string): void {
    const cur = this.sessions.get(tileId);
    if (cur?.state === "exited") return;
    this.apply(tileId, cur?.source ?? null, (s) => ({ ...s, title: title || undefined }));
  }

  forget(tileId: string): void { this.sessions.delete(tileId); }

  private apply(tileId: string, source: StatusSource | null, fold: (s: AgentStatus) => AgentStatus): void {
    const prev = this.sessions.get(tileId);
    const base: AgentStatus = prev ?? INITIAL_STATUS;
    const next = fold(base);
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as unknown as AgentStatus;
    const changedState = !prev || prev.state !== clean.state;
    const status: SessionStatus = { ...clean, source, since: changedState ? this.now() : prev.since };
    if (prev && sameStatus(prev, status)) return;
    this.sessions.set(tileId, status);
    const change: StatusChange = { seq: ++this.seq, tileId, status };
    this.log.push(change);
    const cap = this.opts.logSize ?? 1000;
    if (this.log.length > cap) this.log.splice(0, this.log.length - cap);
    for (const fn of this.listeners) fn(change);
  }
}

function sameStatus(a: SessionStatus, b: SessionStatus): boolean {
  return a.state === b.state && a.kind === b.kind && a.source === b.source && a.background === b.background && a.title === b.title
    && a.compacting === b.compacting && a.subagents.length === b.subagents.length && a.subagents.every((x, i) => x === b.subagents[i]);
}

export type { SessionState };
