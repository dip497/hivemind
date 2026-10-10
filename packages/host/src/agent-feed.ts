/**
 * The agents of the workspaces here, as one feed every reader follows (the workspace API's
 * `agent.list`, `agent.changed`, `agent.event`): widgets, views, notifications, a phone, the CLI.
 * Worked out once, here, where the agents' statuses are (design R6), not again by each reader.
 *
 * A reader lists, then watches: `list` gives the agents of a workspace and the feed's position
 * (`seq`); each change after it comes as `agent.changed` (one agent, or its going) and what it
 * means as `agent.event` (a turn ended, it waits on the person, it stopped waiting, it came, it
 * went), each numbered on from that position. A reader that missed some (asleep, reconnected)
 * asks `since` for them; when they are older than the feed keeps, it lists again.
 *
 * However often statuses change, the feed works the agents out at most every `every` ms (titles
 * change about every 600 ms while an agent writes) and tells only what changed; a reader that
 * lists or catches up meanwhile has what is waiting worked out first, so what it was just told
 * was done (a rename) is what it reads.
 */
import type { AgentChange, AgentEvent, AgentItem, Answerer } from "@hivemind/workspace-api/agents";

export type { AgentChange, AgentEvent, AgentEventKind } from "@hivemind/workspace-api/agents";

export interface AgentFeedOptions {
  /** Every agent here, now. */
  build(): AgentItem[];
  /** Tell every client: `agent.changed` or `agent.event`, the workspace's folder first. */
  publish(event: "agent.changed" | "agent.event", repo: string, payload: AgentChange | AgentEvent): void;
  /** The folder of the workspace with this id, or null when it is not held here. */
  repoOf(workspace: string): string | null;
  /** How the wait of `tile` that began at `since` was answered, and by whom, when it was. */
  answerOf?(tile: string, since: number): { decision: string; by: Answerer | null } | undefined;
  /** The least time between two workings-out (ms). */
  every?: number;
  /** How many changes and events the feed keeps for a reader catching up. */
  keep?: number;
  now?(): number;
}

const TURN_ENDS = new Set(["done", "failed", "interrupted", "limited"]);
/** The longest report the feed carries. */
const REPORT_MAX = 10_000;

export class AgentFeed {
  private agents = new Map<string, AgentItem>();
  private seq = 0;
  /** What was told, oldest first, for `since`: by workspace, so a reader catches up on its own. */
  private told: Array<{ workspace: string; change?: AgentChange; event?: AgentEvent }> = [];
  private due: ReturnType<typeof setTimeout> | null = null;
  private lastAt = -Infinity;
  private readonly every: number;
  private readonly keep: number;
  private readonly now: () => number;

  constructor(private readonly o: AgentFeedOptions) {
    this.every = o.every ?? 250;
    this.keep = o.keep ?? 1000;
    this.now = o.now ?? Date.now;
    this.agents = new Map(o.build().map((a) => [a.tile, a]));
  }

  /** Something an agent's status depends on changed: work them out again, soon. */
  changed(): void {
    if (this.due) return;
    const wait = this.every - (this.now() - this.lastAt);
    if (wait <= 0) return this.refresh();
    this.due = setTimeout(() => this.refresh(), wait);
    (this.due as { unref?: () => void }).unref?.();
  }

  /** What waits out the interval, worked out now. */
  private settle(): void {
    if (this.due) this.refresh();
  }

  /** The agents of the workspace `workspace` now, and the feed's position. */
  list(workspace: string): { seq: number; agents: AgentItem[] } {
    this.settle();
    return { seq: this.seq, agents: [...this.agents.values()].filter((a) => a.workspace === workspace) };
  }

  /** What `workspace`'s readers were told after `seq`, or null when the feed no longer keeps all
   *  of it: list again. */
  since(workspace: string, seq: number): { seq: number; changes: AgentChange[]; events: AgentEvent[] } | null {
    this.settle();
    if (seq > this.seq) return null;
    const oldest = this.told[0]?.change?.seq ?? this.told[0]?.event?.seq ?? this.seq + 1;
    if (seq < this.seq && seq + 1 < oldest) return null;
    const after = this.told.filter((t) => t.workspace === workspace && ((t.change?.seq ?? t.event?.seq ?? 0) > seq));
    return {
      seq: this.seq,
      changes: after.flatMap((t) => (t.change ? [t.change] : [])),
      events: after.flatMap((t) => (t.event ? [t.event] : [])),
    };
  }

  /** Work the agents out now and tell what changed. */
  refresh(): void {
    if (this.due) clearTimeout(this.due);
    this.due = null;
    this.lastAt = this.now();
    const next = new Map(this.o.build().map((a) => [a.tile, a]));
    for (const [tile, agent] of next) {
      const was = this.agents.get(tile);
      if (was && JSON.stringify(was) === JSON.stringify(agent)) continue;
      this.tell(agent.workspace, { seq: ++this.seq, agent });
      for (const e of eventsOf(was, agent, this.o.answerOf)) this.tell(agent.workspace, undefined, { seq: ++this.seq, at: this.lastAt, tile, ...e });
    }
    for (const [tile, was] of this.agents) {
      if (next.has(tile)) continue;
      this.tell(was.workspace, { seq: ++this.seq, gone: tile });
      this.tell(was.workspace, undefined, { seq: ++this.seq, at: this.lastAt, tile, kind: "went" });
    }
    this.agents = next;
  }

  /** The agent `tile` reported `message` to the program that started it: told to its workspace's
   *  readers, as long as the feed knows the agent. */
  report(tile: string, message: string): void {
    const agent = this.agents.get(tile);
    if (agent) this.tell(agent.workspace, undefined, { seq: ++this.seq, at: this.now(), tile, kind: "reported", detail: message.slice(0, REPORT_MAX) });
  }

  /** Stop: nothing more is worked out. */
  close(): void {
    if (this.due) clearTimeout(this.due);
    this.due = null;
  }

  private tell(workspace: string, change?: AgentChange, event?: AgentEvent): void {
    this.told.push({ workspace, ...(change ? { change } : {}), ...(event ? { event } : {}) });
    if (this.told.length > this.keep) this.told.splice(0, this.told.length - this.keep);
    const repo = this.o.repoOf(workspace);
    if (!repo) return;
    if (change) this.o.publish("agent.changed", repo, change);
    if (event) this.o.publish("agent.event", repo, event);
  }
}

/** What an agent's change from `was` to `now` means. */
function eventsOf(was: AgentItem | undefined, now: AgentItem, answerOf: AgentFeedOptions["answerOf"]): Array<Pick<AgentEvent, "kind" | "detail" | "by">> {
  if (!was) return [{ kind: "came" }];
  const out: Array<Pick<AgentEvent, "kind" | "detail" | "by">> = [];
  if (now.state !== was.state && TURN_ENDS.has(now.state) && !TURN_ENDS.has(was.state)) out.push({ kind: "turnEnded", detail: now.state });
  if (was.waiting && (!now.waiting || now.waiting.since !== was.waiting.since)) {
    const answer = answerOf?.(now.tile, was.waiting.since);
    out.push({ kind: "answered", ...(answer ? { detail: answer.decision, ...(answer.by ? { by: answer.by } : {}) } : {}) });
  }
  if (now.waiting && (!was.waiting || was.waiting.since !== now.waiting.since)) out.push({ kind: "waiting", detail: now.waiting.kind });
  return out;
}
