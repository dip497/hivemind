/**
 * Answering what an agent waits on, from another of the person's devices or a program (M5,
 * spec/needs.md "Answering"). A wait is named by its tile and when it began (`since`, as
 * `agent.list` gives it): an answer lands only while the agent still waits on that wait, and once,
 * so one that comes late, or again, does nothing and says so. A plan or a supervised tool use is
 * decided (`waits.ts`); a permission on the agent's screen is allowed or denied with the keys its
 * agent says do that (0.5); anything else is one line typed into the agent's terminal, Enter after
 * it. Typed as the person types, through the control plane, so the agent's status hears it; not
 * while the screen shows the agent's prompt or another wait, nor while another answer is going
 * into that terminal (0.7). Electron-free.
 */
import type { AnswerKeys, InputKind } from "@hivemind/agents";
import { keyBytes } from "@hivemind/agent-host/keys";
import type { ScreenReading, SessionStatus } from "@hivemind/agent-host/status-store";
import type { Answerer } from "@hivemind/workspace-api/agents";
import { ApiError, oneOf, text, written } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import { toBareId, toPtyId } from "@hivemind/workspace-api/tile-id";
import type { ControlPlane } from "./control/plane.js";
import { waitsOnThePerson } from "./needs.js";

/** What answering needs of the control plane: the agents' statuses and waits, and typing as the
 *  person. */
export type AnswerPlane = Pick<ControlPlane, "status" | "waits" | "answer">;

export interface AnswersOptions {
  /** The control plane of the agents here. */
  plane(): AnswerPlane;
  /** The keys that allow and deny a permission the agent of `tile` asks, by its status, as it
   *  says; undefined for another wait, and when it says none. */
  answerKeys(tile: string, status: { kind?: InputKind; says?: string }): AnswerKeys | undefined;
  /** Who is at a connection. */
  who(connection: Connection): Answerer;
}

/** Whether the screen, read since the wait began, may still show it: not when it shows the
 *  agent's prompt, nor a wait its rules say is another screen. A screen its rules cannot place
 *  reads as working, which says nothing either way. */
const mayShow = (read: ScreenReading | undefined, wait: SessionStatus): boolean =>
  !read || read.at < wait.since || read.state === "working"
  || (read.state !== "idle" && (read.says === undefined || read.says === wait.says));

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

/** How an answer is recorded: its decision, else that it was a reply. */
const decidedOf = (answer: unknown): string => {
  const d = (answer as { decision?: unknown } | null)?.decision;
  return d === "allow" || d === "deny" ? d : "reply";
};

export function answers(o: AnswersOptions): Domain<"agent.answer"> {
  const answered = new Set<string>();
  return {
    answers: {
      "agent.answer": (from, tile, since, answer) => {
        const bare = toBareId(text(tile, "tile"));
        if (typeof since !== "number") throw new ApiError("BAD_REQUEST", "since must be a number");
        const a = (answer ?? {}) as { text?: unknown; decision?: unknown; feedback?: unknown; always?: unknown };
        const plane = o.plane();
        const held = plane.waits.of(bare);
        if (held?.since === since) {
          if (held.answerer && !mayAnswerFor(from, held.answerer)) throw new ApiError("FORBIDDEN", "only the person, or the program that started it, answers what this agent asks");
          const decision = oneOf(a.decision, "answer.decision", ["allow", "deny"] as const);
          const feedback = a.feedback == null ? undefined : written(a.feedback, "answer.feedback");
          if (a.always !== undefined && (a.always !== true || held.kind !== "approval")) throw new ApiError("BAD_REQUEST", "answer.always is true, and answers a supervised tool use alone");
          return plane.waits.answer(bare, since, decision, { feedback, by: o.who(from), always: a.always === true });
        }
        const before = plane.waits.answerOf(bare, since);
        if (before) return { answered: false, ...(before.by ? { by: before.by } : {}) };
        const status = plane.status.get(bare);
        // Waits on the person no more, or on another wait, or answered already: nothing.
        if (!status || !waitsOnThePerson(status) || status.since !== since || answered.has(`${bare}@${since}`)) return { answered: false };
        let parts: string[];
        if (a.decision !== undefined) {
          const decision = oneOf(a.decision, "answer.decision", ["allow", "deny"] as const);
          const keys = o.answerKeys(bare, status)?.[decision];
          if (!keys) throw new ApiError("BAD_REQUEST", "this agent is answered on its screen: it says no keys that allow or deny what it asks");
          parts = keys.map(keyBytes);
        } else {
          parts = [`${line(a.text, "answer.text")}\r`];
        }
        // Its screen shows something else now: typed there, the keys would answer that.
        if (!mayShow(plane.status.reading(bare), status)) return { answered: false };
        const done = plane.answer(toPtyId(bare), parts);
        if (done) {
          answered.add(`${bare}@${since}`);
          if (answered.size > ANSWERED_KEPT) answered.delete(answered.values().next().value!);
        }
        return { answered: done };
      },
    },
    effects: {
      // What was decided, never what was said: a reply is recorded as one.
      "agent.answer": (tile, _since, answer) => ({
        target: typeof tile === "string" ? toBareId(tile) : undefined,
        detail: (r: { answered?: boolean } | null) => `${decidedOf(answer)}${r?.answered ? "" : ", not answered"}`,
      }),
    },
  };
}
