/**
 * Plans agents hand off for review (M2; design §4.2 D 6). Every client is told of each one
 * (`plan.review`), and may ask which are waiting in a workspace (`plan.list`); one who may drive
 * agents answers it (`plan.decide`: the host's windows, a guest given *Can drive agents*). The first
 * answer is the one the agent gets, and everyone is told who gave it (`plan.decided`); a later one
 * changes nothing and hears who answered first. A plan whose agent stops waiting is told as
 * answered by nobody. Electron-free.
 */
import { oneOf, text, written } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import type { EventParams } from "@hivemind/workspace-api/methods";
import type { Answerer, PlanReview } from "@hivemind/workspace-api/plans";
import { toBareId } from "../../shared/tile-id.js";

export interface PlansOptions {
  /** Tell every client. */
  publish<E extends "plan.review" | "plan.decided">(event: E, ...params: EventParams<E>): void;
  /** Who is at a connection. */
  who(connection: Connection): Answerer;
  /** The repo of the workspace a tile is in, or null. */
  repoOf(tile: string): string | null;
}

type Decision = "allow" | "deny";

interface Waiting {
  review: PlanReview;
  reply(decision: Decision, feedback?: string): void;
}

/** Who answered the plans answered lately: a late answer hears who was first. */
const ANSWERED_KEPT = 256;

export class Plans {
  readonly domain: Domain<"plan.list" | "plan.decide">;
  private readonly waiting = new Map<string, Waiting>();
  private readonly answered = new Map<string, Answerer | null>();

  constructor(private readonly opts: PlansOptions) {
    this.domain = {
      answers: {
        "plan.list": (_from, repo) => {
          const r = text(repo, "repo");
          return [...this.waiting.values()].map((w) => w.review).filter((review) => opts.repoOf(toBareId(review.tileId)) === r);
        },
        "plan.decide": (from, tile, requestId, decision, feedback) => this.decide(
          from,
          text(tile, "tile"),
          text(requestId, "requestId"),
          oneOf(decision, "decision", ["allow", "deny"] as const),
          feedback == null ? undefined : written(feedback, "feedback"),
        ),
      },
      effects: {
        "plan.decide": (tile, _requestId, decision) => ({
          target: typeof tile === "string" ? toBareId(tile) : undefined,
          detail: decision === "allow" || decision === "deny" ? decision : undefined,
        }),
      },
    };
  }

  /** An agent handed off a plan: everyone is told, and `reply` gives it the first answer. */
  ask(review: PlanReview, reply: (decision: Decision, feedback?: string) => void): void {
    this.waiting.set(review.requestId, { review, reply });
    this.opts.publish("plan.review", review);
  }

  /** The agent stopped waiting on `requestId` before anyone answered. */
  drop(requestId: string): void {
    const waiting = this.waiting.get(requestId);
    if (!waiting) return;
    this.waiting.delete(requestId);
    this.remember(requestId, null);
    this.opts.publish("plan.decided", { requestId, tileId: waiting.review.tileId, decision: null, by: null });
  }

  private decide(from: Connection, tile: string, requestId: string, decision: Decision, feedback: string | undefined): { answered: boolean; by: Answerer | null } {
    const waiting = this.waiting.get(requestId);
    // Answered already, or not the plan of this tile (whose workspace was checked).
    if (!waiting || toBareId(waiting.review.tileId) !== toBareId(tile)) return { answered: false, by: this.answered.get(requestId) ?? null };
    this.waiting.delete(requestId);
    const by = this.opts.who(from);
    this.remember(requestId, by);
    waiting.reply(decision, feedback);
    this.opts.publish("plan.decided", { requestId, tileId: waiting.review.tileId, decision, by });
    return { answered: true, by };
  }

  private remember(requestId: string, by: Answerer | null): void {
    this.answered.set(requestId, by);
    if (this.answered.size > ANSWERED_KEPT) this.answered.delete(this.answered.keys().next().value!);
  }
}
