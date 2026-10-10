/**
 * What an agent waits on that an answer ends (spec/needs.md "Answering"): a plan it handed off for
 * review, and a supervised tool use waiting on its starter. One wait per agent, which its status
 * says while it lasts; named by its tile and when it began (`since`), and by its `request` for the
 * agent answering one with `hive ctl approve`. The first answer is the one the agent gets; a later
 * one changes nothing and hears who was first. A supervised tool use answered `always` is decided
 * so for every later use of that tool by that agent, until it goes. A wait that ends before an answer (the agent stopped
 * waiting, or waits on something else now) tells its owner so, with no decision.
 * What waits on the agent's own screen (a permission, a question) is answered there, with keys,
 * and is no wait of these. Electron-free.
 */
import { randomUUID } from "node:crypto";
import type { StatusInput } from "@hivemind/agents";
import type { Answerer } from "@hivemind/workspace-api/agents";

export type Decision = "allow" | "deny";

/** Gives the agent its answer: `null` when the wait ended without one. */
export type Reply = (decision: Decision | null, feedback?: string) => void;

export interface Wait {
  request: string;
  /** The waiting agent's tile, bare. */
  tile: string;
  since: number;
  kind: "plan" | "approval";
  /** plan: the plan, in markdown, and where the agent was working. */
  plan?: string;
  cwd?: string;
  /** approval: the tool, and what it would do. */
  tool?: string;
  summary?: string;
  /** When it stops waiting on an answer. */
  expiresAt?: number;
  /** Who answers it besides the person: the agent or program that started the agent. */
  answerer?: string;
}

export interface WaitsOptions {
  /** The agents' statuses: a wait is the agent's status while it lasts. */
  status: { event(tile: string, input: StatusInput): void; get(tile: string): { since: number } | undefined };
  /** A wait began or ended. */
  changed?(): void;
}

/** Waits answered lately, by `tile@since`: a late answer hears who was first. */
const ANSWERED_KEPT = 256;

export class Waits {
  private readonly held = new Map<string, { wait: Wait; reply: Reply }>();
  private readonly answered = new Map<string, { decision: Decision; by: Answerer | null }>();
  /** What an agent's every use of a tool is decided, by `tile:tool`. */
  private readonly rules = new Map<string, Decision>();

  constructor(private readonly o: WaitsOptions) {}

  /** The agent `tile` waits on `wait`: `reply` gives it the first answer. A wait it was on before
   *  ends unanswered. */
  ask(tile: string, wait: Omit<Wait, "request" | "tile" | "since">, reply: Reply): Wait {
    const before = this.held.get(tile);
    this.held.delete(tile);
    before?.reply(null);
    this.o.status.event(tile, { event: "input.requested", kind: wait.kind });
    const made: Wait = { ...wait, request: randomUUID(), tile, since: this.o.status.get(tile)?.since ?? Date.now() };
    this.held.set(tile, { wait: made, reply });
    this.o.changed?.();
    return made;
  }

  /** What `tile` waits on now. */
  of(tile: string): Wait | undefined {
    return this.held.get(tile)?.wait;
  }

  /** The wait `request` names. */
  named(request: string): Wait | undefined {
    for (const { wait } of this.held.values()) if (wait.request === request) return wait;
    return undefined;
  }

  /** Every wait now. */
  all(): Wait[] {
    return [...this.held.values()].map((h) => h.wait);
  }

  /** The wait `request` stops waiting at `expiresAt` from now on. */
  expires(request: string, expiresAt: number): void {
    const wait = this.named(request);
    if (wait) wait.expiresAt = expiresAt;
    this.o.changed?.();
  }

  /** Answer the wait of `tile` that began at `since`, as `by`, and for a supervised tool use
   *  `always` its every later use: whether this answer was the one it got, and when it was not,
   *  who answered first. */
  answer(tile: string, since: number, decision: Decision, o: { feedback?: string; by?: Answerer | null; always?: boolean } = {}): { answered: boolean; by?: Answerer } {
    const { feedback, by = null } = o;
    const held = this.held.get(tile);
    if (!held || held.wait.since !== since) {
      const first = this.answered.get(`${tile}@${since}`)?.by;
      return { answered: false, ...(first ? { by: first } : {}) };
    }
    this.held.delete(tile);
    if (o.always && held.wait.tool) this.rules.set(`${tile}:${held.wait.tool}`, decision);
    this.answered.set(`${tile}@${since}`, { decision, by });
    if (this.answered.size > ANSWERED_KEPT) this.answered.delete(this.answered.keys().next().value!);
    this.o.status.event(tile, { event: "input.resolved" });
    held.reply(decision, feedback);
    this.o.changed?.();
    return { answered: true };
  }

  /** How the wait of `tile` that began at `since` was answered, and by whom, if it was. */
  answerOf(tile: string, since: number): { decision: Decision; by: Answerer | null } | undefined {
    return this.answered.get(`${tile}@${since}`);
  }

  /** The agent stopped waiting on `request` before an answer: it ends unanswered. */
  drop(request: string): void {
    const wait = this.named(request);
    if (!wait) return;
    const { reply } = this.held.get(wait.tile)!;
    this.held.delete(wait.tile);
    this.o.status.event(wait.tile, { event: "input.resolved" });
    reply(null);
    this.o.changed?.();
  }

  /** How every use of `tool` by `tile` is decided, if it was answered `always`. */
  ruled(tile: string, tool: string): Decision | undefined {
    return this.rules.get(`${tile}:${tool}`);
  }

  /** The agent `tile` went: what it waited on ends unanswered, and it is told so. */
  forget(tile: string): void {
    for (const key of this.rules.keys()) if (key.startsWith(`${tile}:`)) this.rules.delete(key);
    const held = this.held.get(tile);
    if (!held) return;
    this.held.delete(tile);
    held.reply("deny", "the agent closed");
    this.o.changed?.();
  }
}
