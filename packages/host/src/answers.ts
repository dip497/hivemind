/**
 * Answering what an agent waits on, from another of the person's devices or a program (M5,
 * spec/needs.md "Answering"). A wait is named by its tile and when it began (`since`, as
 * `agent.list` gives it): an answer lands only while the agent still waits on that wait, and once,
 * so one that comes late, or again, does nothing and says so. A plan or a supervised tool use is
 * decided (`waits.ts`); a permission on the agent's screen is allowed or denied with the keys its
 * agent says do that (0.5); an option of the one question its tool asks is chosen with the keys its
 * agent says choose (0.7), never allowed or denied; anything else is one line typed into the
 * agent's terminal, Enter after it. Typed as the person types, through the control plane, so the agent's status hears it; not
 * while the screen shows the agent's prompt or another wait, nor while another answer is going
 * into that terminal (0.7). Electron-free.
 */
import type { AnswerKeys, InputKind } from "@hivemind/agents";
import { keyBytes } from "@hivemind/agent-host/keys";
import type { ScreenReading, SessionStatus } from "@hivemind/agent-host/status-store";
import type { Answerer, Approval, QuestionAnswer, ToolAsked } from "@hivemind/workspace-api/agents";
import { ApiError, oneOf, text, written } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import { toBareId, toPtyId } from "@hivemind/workspace-api/tile-id";
import type { ControlPlane } from "./control/plane.js";
import { TOOL_MAX } from "./conversation.js";
import { waitOn, waitsOnThePerson } from "./needs.js";

/** What answering needs of the control plane: the agents' statuses and waits, and typing as the
 *  person. */
export type AnswerPlane = Pick<ControlPlane, "status" | "waits" | "answer">;

export interface AnswersOptions {
  /** The control plane of the agents here. */
  plane(): AnswerPlane;
  /** The keys that allow and deny a permission the agent of `tile` asks, by its status, as it
   *  says; undefined for another wait, and when it says none. */
  answerKeys(tile: string, status: { kind?: InputKind; says?: string }): AnswerKeys | undefined;
  /** The tool use the agent of `tile` waits on, as its session file says. */
  asking(tile: string): ToolAsked | undefined;
  /** The keys that choose an option of a question the agent of `tile` asks, `{n}` its number from
   *  1; undefined when it says none. */
  chooseKeys(tile: string): readonly string[] | undefined;
  /** Who is at a connection. */
  who(connection: Connection): Answerer;
  /** Whether the screen rules of the agent of `tile` read what it waits on: its answer is then
   *  typed once its screen shows the wait, and is confirmed once its screen moves on from it. */
  watched?(tile: string): boolean;
}

/** How long an answer waits for the agent's screen to show what it asks, and then to move on from
 *  it once the keys are in. */
export const DRAWN_MS = 4_000;
export const TAKEN_MS = 3_000;

/** Whether `read` shows a wait of `kind`: as itself, or as one its rules do not tell apart. */
const shows = (read: ScreenReading | undefined, kind: InputKind | undefined): boolean =>
  !!read && (read.state === "blocked" || (kind === "permission" || kind === "question" ? read.state === kind : read.state !== "idle" && read.state !== "working"));

/** Whether `ok` holds now, or once a screen of `tile` read within `ms` makes it. */
function until(plane: AnswerPlane, tile: string, ok: () => boolean, ms: number): Promise<boolean> {
  if (ok()) return Promise.resolve(true);
  return new Promise((done) => {
    const finish = (v: boolean) => { stop(); clearTimeout(timer); done(v); };
    const stop = plane.status.onScreen((t) => { if (t === tile && ok()) finish(true); });
    const timer = setTimeout(() => finish(false), ms);
  });
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

const NOT_ANSWERS = "answer.answers is one answer to each question it asks, in order: {chosen: [options, from 0]}, one unless several may be, or {text}";

/** One answer to each question `on` is chosen from, in order: else `BAD_REQUEST`. */
function answersOf(on: ReturnType<typeof waitOn>, value: unknown): QuestionAnswer[] {
  const asks = on.choose ? on.asks! : [];
  if (!Array.isArray(value) || !asks.length || value.length !== asks.length) throw new ApiError("BAD_REQUEST", NOT_ANSWERS);
  return value.map((a: unknown, i): QuestionAnswer => {
    const { chosen, text: said } = (a ?? {}) as { chosen?: unknown; text?: unknown };
    if (said !== undefined && chosen === undefined) return { text: line(said, `answer.answers[${i}].text`) };
    const q = asks[i]!;
    const ok = Array.isArray(chosen) && chosen.length > 0 && (chosen.length === 1 || !!q.many) && new Set(chosen).size === chosen.length
      && chosen.every((n) => Number.isSafeInteger(n) && n >= 0 && n < q.options.length);
    if (!ok) throw new ApiError("BAD_REQUEST", NOT_ANSWERS);
    return { chosen: chosen as number[] };
  });
}

const NOT_DECIDED = "it asks a question: an option of it is chosen, or a line is typed, never allowed or denied";

/** How an answer is recorded: its decision; the options chosen (from 1) of each question, or that
 *  it was a reply; else that it was a reply. Never its words. */
const decidedOf = (answer: unknown): string => {
  const { decision, answers } = (answer ?? {}) as { decision?: unknown; answers?: unknown };
  if (decision === "allow" || decision === "deny") return decision;
  if (!Array.isArray(answers)) return "reply";
  const each = answers.map((a: { chosen?: unknown } | null) => (Array.isArray(a?.chosen) ? a.chosen.map((n) => Number(n) + 1).join("+") : "reply"));
  return `choice ${each.join(", ")}`;
};

export function answers(o: AnswersOptions): Domain<"agent.answer" | "agent.approval"> {
  const answered = new Set<string>();
  return {
    answers: {
      // What the person or the starter decides on, whole: the summary its supervisor is told is cut.
      "agent.approval": (_from, tile): Approval => {
        const wait = o.plane().waits.of(toBareId(text(tile, "tile")));
        if (wait?.kind !== "approval") throw new ApiError("NOT_FOUND", "that agent waits on no supervised tool use");
        const whole = typeof wait.input === "string" ? wait.input : JSON.stringify(wait.input ?? {}, null, 2);
        return {
          request: wait.request, since: wait.since, tool: wait.tool!, summary: wait.summary!, input: whole.slice(0, TOOL_MAX),
          expiresAt: wait.expiresAt!, ...(whole.length > TOOL_MAX ? { truncated: true as const } : {}),
        };
      },
      "agent.answer": (from, tile, since, answer) => {
        const bare = toBareId(text(tile, "tile"));
        if (typeof since !== "number") throw new ApiError("BAD_REQUEST", "since must be a number");
        const a = (answer ?? {}) as { text?: unknown; decision?: unknown; answers?: unknown; feedback?: unknown; always?: unknown };
        const plane = o.plane();
        const held = plane.waits.of(bare);
        if (held?.since === since && held.prompt) {
          // Its own hook holds for the answer, and prints it.
          if (a.always !== undefined) throw new ApiError("BAD_REQUEST", "answer.always is true, and answers a supervised tool use alone");
          const on = waitOn(bare, { kind: held.kind, since }, { decides: () => true, wait: () => held });
          const by = o.who(from);
          if (a.answers !== undefined) return plane.waits.answer(bare, since, "allow", { by, answers: answersOf(on, a.answers) });
          if (a.decision !== undefined) {
            if (on.kind === "question") throw new ApiError("BAD_REQUEST", NOT_DECIDED);
            const decision = oneOf(a.decision, "answer.decision", ["allow", "deny"] as const);
            const feedback = a.feedback == null ? undefined : written(a.feedback, "answer.feedback");
            return plane.waits.answer(bare, since, decision, { feedback, by });
          }
          // A line answers its questions, or tells it what to do instead.
          return plane.waits.answer(bare, since, on.kind === "question" ? "allow" : "deny", { feedback: line(a.text, "answer.text"), by });
        }
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
        const on = waitOn(bare, { kind: status.kind!, says: status.says, since }, { decides: () => false, asked: (t) => plane.waits.asked(t), asking: o.asking, chooses: (t) => !!o.chooseKeys(t) });
        let parts: string[];
        if (a.answers !== undefined) {
          // Its keys choose one option of its one question; a line is typed as {text}.
          const [only] = answersOf(on, a.answers);
          if (!only || !("chosen" in only)) throw new ApiError("BAD_REQUEST", "this agent's question is answered on its screen: one option of it, or a line as {text}");
          parts = o.chooseKeys(bare)!.map((k) => keyBytes(k.replaceAll("{n}", String(only.chosen[0]! + 1))));
        } else if (a.decision !== undefined) {
          if (on.kind === "question") throw new ApiError("BAD_REQUEST", NOT_DECIDED);
          const decision = oneOf(a.decision, "answer.decision", ["allow", "deny"] as const);
          const keys = o.answerKeys(bare, status)?.[decision];
          if (!keys) throw new ApiError("BAD_REQUEST", "this agent is answered on its screen: it says no keys that allow or deny what it asks");
          parts = keys.map(keyBytes);
        } else {
          parts = [`${line(a.text, "answer.text")}\r`];
        }
        const key = `${bare}@${since}`;
        const type = (): boolean => {
          // Its screen shows something else now: typed there, the keys would answer that.
          if (!mayShow(plane.status.reading(bare), status)) return false;
          const done = plane.answer(toPtyId(bare), parts);
          if (done) {
            answered.add(key);
            if (answered.size > ANSWERED_KEPT) answered.delete(answered.values().next().value!);
          }
          return done;
        };
        if (!o.watched?.(bare)) return { answered: type() };
        // Keys typed before its chooser is drawn never reach it: typed once its screen shows the
        // wait, and confirmed once its screen moves on, or a new wait begins.
        const waits = () => { const now = plane.status.get(bare); return !!now && now.state === "waiting" && now.since === since; };
        return (async () => {
          if (!(await until(plane, bare, () => !waits() || shows(plane.status.reading(bare), status.kind), DRAWN_MS)) || !waits()) {
            if (!waits()) return { answered: false };
            throw new ApiError("TIMEOUT", "its screen has not shown what it asks: nothing was typed; answer it there");
          }
          const before = plane.status.reading(bare);
          if (!type()) return { answered: false };
          const moved = () => {
            const read = plane.status.reading(bare);
            const now = plane.status.get(bare);
            // Its screen moved on, or it waits anew, on what came after.
            return (read !== before && !shows(read, status.kind)) || (now?.state === "waiting" && now.since > since);
          };
          if (await until(plane, bare, moved, TAKEN_MS)) return { answered: true };
          // Its screen is read on a change only, and late: the keys went in, so they are never typed again.
          throw new ApiError("TIMEOUT", "the keys went in, but its screen has not moved on yet: not confirmed; check it there");
        })();
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
