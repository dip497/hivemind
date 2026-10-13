// The answers to what an agent waits on (spec/needs.md "Answering"), as the Android app's
// Answering.kt has them: Allow and Deny for a permission its device can decide, below the tool and
// what it is about; a question's options to choose from; Approve or Ask for changes for a plan; and
// a line of reply for anything else. One place for the Needs you list and
// the agent's own screen, whose message box is where the line is typed. An answer the computer did not confirm is not offered again: it may have
// landed, and a second would answer whatever the agent asks next.

import { composer, h, pill } from "./dom.js";
import { markdown } from "./markdown.js";
import { NOTICES } from "./words.js";
import type { QuestionAnswer, Reply, Waiting } from "./types.js";

type Asked = NonNullable<Waiting["asks"]>[number];

/** Waits answered with no word back, by tile and since. */
const unconfirmed = new Set<string>();

/** The answers drawn, and how a line typed in the screen's own box answers, when the wait takes one:
 *  its hint and its sending, which says whether it landed. */
export interface Answers {
  el: HTMLElement;
  typed: { hint: string; send: (text: string) => Promise<boolean> } | null;
}

/** `boxed`: the screen has a box of its own to type in, so none is drawn here. */
export function answers(tile: string, w: Waiting, answer: (reply: Reply) => Promise<boolean | null>, boxed = false): Answers {
  const box = h("div", { class: "answers" });
  const wait = `${tile}@${w.since}`;
  const sentAlready = () => box.replaceChildren(h("p", { class: "status problem", "data-unconfirmed": "" }, NOTICES.unconfirmed));
  if (unconfirmed.has(wait)) {
    sentAlready();
    return { el: box, typed: null };
  }
  // Answering, or reading the plan, is not opening the agent.
  box.addEventListener("click", (e) => e.stopPropagation());
  // One answer at a time.
  const hold = async (reply: Reply) => {
    box.inert = true;
    try {
      const landed = await answer(reply);
      if (landed === null) {
        unconfirmed.add(wait);
        sentAlready();
      }
      return landed;
    } finally {
      box.inert = false;
    }
  };
  const line = (hint: string): Answers["typed"] => {
    const send = async (text: string) => !box.inert && (await hold({ text })) === true;
    if (!boxed) box.append(composer(hint, send, { "data-reply": "" }));
    return { hint, send };
  };
  let typed: Answers["typed"] = null;
  if (w.tool) {
    // Its command, four lines of it until tapped.
    const command = w.tool.about ? h("pre", { class: "mono command" }, w.tool.about) : null;
    command?.addEventListener("click", () => command.toggleAttribute("data-whole"));
    box.append(h("div", { class: "asked", "data-tool": w.tool.name }, h("p", { class: "tool-name" }, w.tool.name), command));
  }
  const asks = w.kind === "question" && w.choose ? w.asks ?? [] : [];
  if (!asks.length) {
    for (const q of w.asks ?? []) {
      box.append(h("div", { class: "asked", "data-question": "" }, h("p", {}, q.question), h("ul", {}, ...q.options.map((o) => h("li", {}, o)))));
    }
  }
  if (asks.length === 1 && !asks[0]!.many) {
    // One option of one question: a tap answers it.
    const q = asks[0]!;
    box.append(h("div", { class: "asked", "data-question": "" }, h("p", {}, q.question)),
      h("div", { class: "choices" }, ...q.options.map((o, n) => {
        const choice = option(q, n);
        choice.addEventListener("click", () => void hold({ answers: [{ chosen: [n] }] }));
        return choice;
      })));
    typed = line(boxed ? "Or type your own answer" : "Type something");
  } else if (asks.length) {
    box.append(form(asks, (answers) => void hold({ answers })));
  } else if (w.kind === "permission" && w.decide) {
    // Full-width rows, yes first (Happy's PermissionFooter.tsx:500-592).
    box.append(h("div", { class: "rows" },
      pill("Allow", () => void hold({ allow: true }), "primary", { "data-answer": "allow" }),
      pill("Deny", () => void hold({ allow: false }), "", { "data-answer": "deny" })));
  } else if (w.kind === "plan") {
    const plan = w.plan ? h("div", { class: "plan md", hidden: true, "data-plan": "" }, ...markdown(w.plan)) : null;
    const read = plan && pill("Read the plan", () => {
      plan.hidden = false;
      read!.hidden = true;
    }, "", { "data-answer": "plan" });
    const changes = composer("What to change", async (feedback) => (await hold({ approve: false, feedback })) === true, { "data-changes": "" });
    changes.hidden = true;
    const ask = pill("Ask for changes", () => {
      changes.hidden = false;
      ask.hidden = true;
      changes.querySelector("textarea")!.focus();
    }, "", { "data-answer": "changes" });
    box.append(...[plan, changes, read].filter((e) => e !== null), h("div", { class: "row" },
      ask, pill("Approve", () => void hold({ approve: true }), "primary", { "data-answer": "approve" })));
  } else {
    typed = line("Reply");
  }
  return { el: box, typed };
}

/** Option `n` of `q`: its label, and what it means when it says. */
function option(q: Asked, n: number): HTMLButtonElement {
  const said = q.descriptions?.[n];
  return h("button", { type: "button", class: "choice", "data-choice": String(n) },
    h("span", { class: "label" }, q.options[n]!), ...(said ? [h("span", { class: "description" }, said)] : []));
}

/** Several questions, or one of several answers: each its own options and a line of its own, the
 *  one or the other; one Send once each has an answer (hapi keeps the same per question,
 *  AskUserQuestionFooter.tsx:59-115). */
function form(asks: Asked[], send: (answers: QuestionAnswer[]) => void): HTMLElement {
  const chosen = asks.map(() => new Set<number>());
  const own = asks.map(() => "");
  const go = pill("Send", () => send(asks.map((_, i): QuestionAnswer => (own[i] ? { text: own[i]! } : { chosen: [...chosen[i]!].sort((a, b) => a - b) }))), "primary", { "data-answer": "send" });
  const ready = () => (go.disabled = !asks.every((_, i) => own[i] || chosen[i]!.size));
  const blocks = asks.map((q, i) => {
    const typed = h("input", { class: "field", maxlength: 1000, enterkeyhint: "done", placeholder: "Type something", "aria-label": `Your own answer to: ${q.question}`, "data-own": "" });
    const buttons = q.options.map((_, n) => {
      const choice = option(q, n);
      choice.setAttribute("aria-pressed", "false");
      choice.addEventListener("click", () => {
        const picked = chosen[i]!;
        if (!q.many) picked.clear();
        if (picked.has(n)) picked.delete(n);
        else picked.add(n);
        typed.value = own[i] = "";
        show();
      });
      return choice;
    });
    const show = () => {
      for (const [n, b] of buttons.entries()) b.setAttribute("aria-pressed", String(chosen[i]!.has(n)));
      ready();
    };
    typed.addEventListener("input", () => {
      own[i] = typed.value.trim();
      if (own[i]) chosen[i]!.clear();
      show();
    });
    return h("div", { class: "asked", "data-question": String(i) },
      h("p", {}, q.question), q.many ? h("p", { class: "status" }, "Choose any") : null,
      h("div", { class: "choices" }, ...buttons), typed);
  });
  ready();
  return h("div", { class: "form", "data-questions": "" }, ...blocks, go);
}
