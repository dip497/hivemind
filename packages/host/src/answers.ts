/**
 * Answering what an agent waits on, from another of the person's devices or a program (M5,
 * spec/needs.md "Answering"). A wait is named by its tile and when it began (`since`, as
 * `agent.list` gives it): an answer lands only while the agent still waits on that wait, and once,
 * so one that comes late, or again, does nothing and says so. A plan or a supervised tool use is
 * decided (`waits.ts`); a permission on the agent's screen is allowed or denied with the keys its
 * agent says do that (0.5); anything else is one line typed into the agent's terminal, Enter after
 * it. And sending an agent a message, whatever it is doing (spec/needs.md "Sending"): one line,
 * handed to it as `hive ctl send` hands one, as its next prompt once it is at its prompt.
 * Electron-free.
 */
import type { AnswerKeys, InputKind } from "@hivemind/agents";
import { typeKeys } from "@hivemind/agent-host/keys";
import type { Answerer } from "@hivemind/workspace-api/agents";
import { ApiError, oneOf, text, written } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { waitsOnThePerson } from "./needs.js";
import type { Waits } from "./waits.js";

export interface AnswersOptions {
  /** A tile's agent's status now, by its tile. */
  status(tile: string): { state: string; kind?: InputKind; says?: string; since: number } | undefined;
  /** Type `data` into the terminal of `tile` now; false when it has none. */
  type(tile: string, data: string): boolean;
  /** The keys that allow and deny a permission the agent of `tile` asks, by its status, as it
   *  says; undefined for another wait, and when it says none. */
  answerKeys(tile: string, status: { kind?: InputKind; says?: string }): AnswerKeys | undefined;
  /** Hand `text` to the agent of `tile` as a message: typed in, Enter after it, once it is at its
   *  prompt; false when it has no terminal. */
  deliver(tile: string, text: string): boolean;
  /** The plans and supervised tool uses agents wait on. */
  waits: Waits;
  /** Who is at a connection. */
  who(connection: Connection): Answerer;
}

/** Who may answer what an agent's starter answers (a supervised tool use): the person, their own
 *  devices, and the program that started it; not a guest, nor another program. (An agent that
 *  started one answers with `hive ctl approve`.) */
const mayAnswerFor = (from: Connection, answerer: string): boolean =>
  from.actor.kind === "person"
  || (from.actor.kind === "peer" && ((from.actor.access === "owner" && !from.actor.client) || from.actor.person === answerer));

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
        const held = o.waits.of(bare);
        if (held?.since === since) {
          if (held.answerer && !mayAnswerFor(from, held.answerer)) throw new ApiError("FORBIDDEN", "only the person, or the program that started it, answers what this agent asks");
          const decision = oneOf(a.decision, "answer.decision", ["allow", "deny"] as const);
          const feedback = a.feedback == null ? undefined : written(a.feedback, "answer.feedback");
          return o.waits.answer(bare, since, decision, feedback, o.who(from));
        }
        const before = o.waits.answerOf(bare, since);
        if (before) return { answered: false, ...(before.by ? { by: before.by } : {}) };
        const status = o.status(bare);
        // Waits on the person no more, or on another wait, or answered already: nothing.
        if (!status || !waitsOnThePerson(status) || status.since !== since || answered.has(`${bare}@${since}`)) return { answered: false };
        let done: boolean;
        if (a.decision !== undefined) {
          const decision = oneOf(a.decision, "answer.decision", ["allow", "deny"] as const);
          const keys = o.answerKeys(bare, status)?.[decision];
          if (!keys) throw new ApiError("BAD_REQUEST", "this agent is answered on its screen: it says no keys that allow or deny what it asks");
          done = typeKeys((bytes) => o.type(bare, bytes), keys);
        } else {
          done = o.type(bare, `${line(a.text, "answer.text")}\r`);
        }
        if (done) {
          answered.add(`${bare}@${since}`);
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
