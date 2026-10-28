// The answers to what an agent waits on (spec/needs.md "Answering"), as the Android app's
// Answering.kt has them: Allow and Deny for a permission its device can decide, below the tool and
// what it is about; a question's options to choose from; Approve or Ask for changes for a plan; and
// a line of reply for anything else. One place for the Needs you list and
// the agent's own screen, whose message box is where the line is typed. An answer the computer did not confirm is not offered again: it may have
// landed, and a second would answer whatever the agent asks next.

import { composer, h, icon, pill } from "./dom.js";
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
    box.append(h("div", { class: "asked", "data-tool": w.tool.name }, h("p", { class: "tool-name" }, icon("agents"), w.tool.name), command));
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

/** Several questions, or one of several answers: one question at a time, as Claude Code asks them.
 *  A chip for each across the top, ticked once answered; choosing the one option of a question goes
 *  on to the next, and a line of its own answers it instead. After the last, every answer to check,
 *  each tapped to change it, and one Send. */
function form(asks: Asked[], send: (answers: QuestionAnswer[]) => void): HTMLElement {
  const chosen = asks.map(() => new Set<number>());
  const own = asks.map(() => "");
  const several = asks.length > 1;
  const answered = (i: number) => !!own[i] || chosen[i]!.size > 0;
  const said = (i: number) => own[i] || [...chosen[i]!].sort((a, b) => a - b).map((n) => asks[i]!.options[n]).join(", ");
  const all = () => asks.every((_, i) => answered(i));
  const sent = () => send(asks.map((_, i): QuestionAnswer => (own[i] ? { text: own[i]! } : { chosen: [...chosen[i]!].sort((a, b) => a - b) })));
  const el = h("div", { class: "form", "data-questions": "" });
  /** The question shown, by its place; `asks.length`: the answers to check. */
  let at = 0;
  const go = (to: number) => {
    at = to;
    show();
  };
  const next = () => go(several ? at + 1 : at);

  const chips = () => h("div", { class: "steps", role: "tablist" }, ...asks.map((_, i) => {
    const chip = h("button", { type: "button", class: "step", role: "tab", "aria-selected": String(i === at), "aria-label": `Question ${i + 1}`, "data-step": String(i), ...(answered(i) ? { "data-answered": "" } : {}) }, answered(i) ? `✓ ${i + 1}` : String(i + 1));
    chip.addEventListener("click", () => go(i));
    return chip;
  }), (() => {
    const chip = h("button", { type: "button", class: "step", role: "tab", "aria-selected": String(at === asks.length), "data-step": "check", disabled: !all() }, "Review");
    chip.addEventListener("click", () => go(asks.length));
    return chip;
  })());

  const question = (i: number) => {
    const q = asks[i]!;
    const typed = h("input", { class: "field", maxlength: 1000, enterkeyhint: "next", placeholder: "Type something", value: own[i], "aria-label": `Your own answer to: ${q.question}`, "data-own": "" });
    const buttons = q.options.map((_, n) => {
      const choice = option(q, n);
      choice.setAttribute("aria-pressed", String(chosen[i]!.has(n)));
      choice.addEventListener("click", () => {
        const picked = chosen[i]!;
        own[i] = "";
        if (!q.many) {
          picked.clear();
          picked.add(n);
          if (several) return next();
        } else if (picked.has(n)) picked.delete(n);
        else picked.add(n);
        show();
      });
      return choice;
    });
    const done = several
      ? pill(i === asks.length - 1 ? "Check answers" : "Next", next, "primary", { "data-answer": "next" })
      : pill("Send", sent, "primary", { "data-answer": "send" });
    done.disabled = !answered(i);
    typed.addEventListener("input", () => {
      own[i] = typed.value.trim();
      if (own[i]) chosen[i]!.clear();
      for (const [n, b] of buttons.entries()) b.setAttribute("aria-pressed", String(chosen[i]!.has(n)));
      done.disabled = !answered(i);
    });
    typed.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && answered(i)) done.click();
    });
    const back = several && i > 0 ? pill("Back", () => go(i - 1), "", { "data-answer": "back" }) : null;
    return [
      h("div", { class: "asked", "data-question": String(i) },
        several ? h("p", { class: "status" }, `Question ${i + 1} of ${asks.length}`) : null,
        h("p", {}, q.question), q.many ? h("p", { class: "status" }, "Choose any") : null,
        h("div", { class: "choices" }, ...buttons), typed),
      h("div", { class: "row" }, back, done),
    ];
  };

  const check = () => [
    h("div", { class: "checked", "data-check": "" }, ...asks.map((q, i) => {
      const row = h("button", { type: "button", class: "choice", "data-change": String(i) },
        h("span", { class: "description" }, q.question), h("span", { class: "label" }, said(i)));
      row.addEventListener("click", () => go(i));
      return row;
    })),
    h("div", { class: "row" }, pill("Back", () => go(asks.length - 1), "", { "data-answer": "back" }), pill("Send", sent, "primary", { "data-answer": "send" })),
  ];

  const show = () => {
    el.replaceChildren(...(several ? [chips()] : []), ...(at === asks.length ? check() : question(at)));
  };
  show();
  return el;
}
