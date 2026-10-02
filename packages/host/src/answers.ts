/**
 * Answering what an agent waits on the person for, from another of their devices (M5,
 * spec/needs.md "Answering"). A wait is named by its tile and when it began (`since`, as the needs
 * list gives it): an answer lands only while the agent still waits on that wait, and once, so one
 * that comes late, or again, does nothing and says so. A plan is decided as the person at the
 * desktop decides one; anything else is one line typed into the agent's terminal, Enter after it.
 * And sending an agent a message, whatever it is doing (spec/needs.md "Sending"): one line, handed
 * to it as `hive ctl send` hands one, as its next prompt once it is at its prompt. Electron-free.
 */
import type { InputKind } from "@hivemind/agents";
import { ApiError, oneOf, text, written } from "@hivemind/workspace-api/protocol";
import type { Domain } from "@hivemind/workspace-api/server";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { waitsOnThePerson } from "./needs.js";
import type { Plans } from "./plans.js";

export interface AnswersOptions {
  /** A tile's agent's status now, by its tile. */
  status(tile: string): { state: string; kind?: InputKind; since: number } | undefined;
  /** Type `data` into the terminal of `tile` now; false when it has none. */
  type(tile: string, data: string): boolean;
  /** Hand `text` to the agent of `tile` as a message: typed in, Enter after it, once it is at its
   *  prompt; false when it has no terminal. */
  deliver(tile: string, text: string): boolean;
  /** The plans agents hand off, decided here as at the desktop. */
  plans: Plans;
}

/** The longest line an answer types. */
export const ANSWER_MAX = 1000;
/** Waits answered lately: one answered again is told it was. */
const ANSWERED_KEPT = 256;

/** A line to type, `name`: text on one line, no control characters, not too long. */
function line(value: unknown, name: string): string {
  const t = written(value, name);
  // eslint-disable-next-line no-control-regex
  if (!t || t.length > ANSWER_MAX || /[\u0000-\u001f\u007f]/.test(t)) throw new ApiError("BAD_REQUEST", `${name} is one line of at most ${ANSWER_MAX} characters`);
  return t;
}

export function answers(o: AnswersOptions): Domain<"agent.answer" | "agent.send"> {
  const answered = new Set<string>();
  return {
    answers: {
      "agent.answer": (from, tile, since, answer) => {
        const bare = toBareId(text(tile, "tile"));
        if (typeof since !== "number") throw new ApiError("BAD_REQUEST", "since must be a number");
        const a = (answer ?? {}) as { text?: unknown; decision?: unknown; feedback?: unknown };
        const status = o.status(bare);
        const wait = `${bare}@${since}`;
        // Waits on the person no more, or on another wait, or answered already: nothing.
        if (!status || !waitsOnThePerson(status) || status.since !== since || answered.has(wait)) return { answered: false };
        let done: boolean;
        if (status.kind === "plan") {
          const decision = oneOf(a.decision, "answer.decision", ["allow", "deny"] as const);
          const feedback = a.feedback == null ? undefined : written(a.feedback, "answer.feedback");
          const review = o.plans.reviews().find((r) => toBareId(r.tileId) === bare);
          done = !!review && o.plans.decide(from, bare, review.requestId, decision, feedback).answered;
        } else {
          done = o.type(bare, `${line(a.text, "answer.text")}\r`);
        }
        if (done) {
          answered.add(wait);
          if (answered.size > ANSWERED_KEPT) answered.delete(answered.values().next().value!);
        }
        return { answered: done };
      },
      "agent.send": (_from, tile, message) => ({ sent: o.deliver(toBareId(text(tile, "tile")), line(message, "text")) }),
    },
    effects: {
      "agent.answer": (tile) => ({ target: typeof tile === "string" ? toBareId(tile) : undefined }),
      "agent.send": (tile) => ({ target: typeof tile === "string" ? toBareId(tile) : undefined }),
    },
  };
}
