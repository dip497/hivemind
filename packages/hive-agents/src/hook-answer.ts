/**
 * What an agent's own hook prints to answer what it asks (spec/needs.md "Answering", 0.9), as its
 * manifest's `answer:` entry declares it. Nothing here knows one agent's format; the entry does.
 */
import { valueAt } from "./field-path.js";
import { askedIn, type Asked } from "./transcript.js";
import type { AgentProviderDef, HookAnswer } from "./types.js";

export type { Asked };

/** The entry of `def`'s native event `hook` that carries the answer, if one does. */
export function hookAnswerOf(def: AgentProviderDef | undefined, hook: string): HookAnswer | undefined {
  const spec = def?.hooks?.events[hook];
  return (Array.isArray(spec) ? spec : spec ? [spec] : []).find((e) => e.answer)?.answer;
}

/** The questions a tool's `input` asks, as `answer` reads them; undefined when it asks none. */
export function hookAsks(answer: HookAnswer, input: unknown): Asked[] | undefined {
  return answer.choose && answer.asks ? askedIn(input, answer.asks) : undefined;
}

/** The person's answer to one question: the options chosen, by their place from 0, or a line. */
export type QuestionAnswer = { chosen: number[] } | { text: string };

/** What the person said: allowed or denied, with a reason; or, to its questions, an answer to
 *  each, in order. */
export type HookReply = { decision: "allow" | "deny"; message?: string } | { answers: QuestionAnswer[] };

/** A shape with each `{name}` that stands alone filled from `values`; one with no value leaves. */
function filled(shape: unknown, values: Record<string, unknown>): unknown {
  if (typeof shape === "string") {
    const name = /^\{(\w+)\}$/.exec(shape)?.[1];
    return name === undefined ? shape : values[name];
  }
  if (Array.isArray(shape)) return shape.map((v) => filled(v, values)).filter((v) => v !== undefined);
  if (!shape || typeof shape !== "object") return shape;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    const f = filled(v, values);
    if (f !== undefined) out[k] = f;
  }
  return out;
}

/** What the hook prints for `reply` to what it asked with the tool's `input`; undefined for an
 *  answer to questions its entry cannot set. */
export function printedAnswer(answer: HookAnswer, input: unknown, reply: HookReply): string | undefined {
  if ("decision" in reply) return JSON.stringify(filled(reply.decision === "allow" ? answer.allow : answer.deny, { message: reply.message || undefined }));
  if (!answer.choose || !answer.asks || !answer.chosen || !input || typeof input !== "object") return undefined;
  const asks = answer.asks;
  const list = valueAt(input, asks.list);
  if (!Array.isArray(list) || !list.length || list.length !== reply.answers.length) return undefined;
  const set: Record<string, string> = {};
  for (const [i, q] of list.entries()) {
    const question = valueAt(q, asks.question);
    const a = reply.answers[i]!;
    const said = "text" in a ? a.text : labels(q, a.chosen, answer);
    if (typeof question !== "string" || said === undefined) return undefined;
    set[question] = said;
  }
  return JSON.stringify(filled(answer.choose, { input: { ...(input as Record<string, unknown>), [answer.chosen]: set } }));
}

/** The labels of options `chosen` of question `q`, joined as Claude Code joins several
 *  (code.claude.com/docs/en/agent-sdk/user-input); undefined for none, one it does not list, or
 *  several of a question that takes one. */
function labels(q: unknown, chosen: number[], answer: HookAnswer): string | undefined {
  const asks = answer.asks!;
  const options = valueAt(q, asks.options);
  const many = asks.many !== undefined && valueAt(q, asks.many) === true;
  if (!Array.isArray(options) || !chosen.length || (chosen.length > 1 && !many) || new Set(chosen).size !== chosen.length) return undefined;
  const said = chosen.map((n) => valueAt(options[n], asks.label));
  return said.every((l): l is string => typeof l === "string") ? said.join(", ") : undefined;
}
