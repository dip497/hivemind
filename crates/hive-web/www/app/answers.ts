// The answers to what an agent waits on (spec/needs.md "Answering"), as the Android app's
// Answering.kt has them: Allow and Deny for a permission its device can decide, below the tool and
// what it is about; a question's options to choose from; Approve or Ask for changes for a plan; and
// a line of reply for anything else. One place for the Needs you list and
// the agent's own screen. An answer the computer did not confirm is not offered again: it may have
// landed, and a second would answer whatever the agent asks next.

import { composer, h, pill } from "./dom.js";
import { markdown } from "./markdown.js";
import { NOTICES } from "./words.js";
import type { Reply, Waiting } from "./types.js";

/** Waits answered with no word back, by tile and since. */
const unconfirmed = new Set<string>();

export function answers(tile: string, w: Waiting, answer: (reply: Reply) => Promise<boolean | null>): HTMLElement {
  const box = h("div", { class: "answers" });
  const wait = `${tile}@${w.since}`;
  const sentAlready = () => box.replaceChildren(h("p", { class: "status problem", "data-unconfirmed": "" }, NOTICES.unconfirmed));
  if (unconfirmed.has(wait)) {
    sentAlready();
    return box;
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
  if (w.tool) {
    box.append(h("div", { class: "asked", "data-tool": w.tool.name },
      h("span", { class: "label-small" }, w.tool.name),
      ...(w.tool.about ? [h("pre", { class: "mono" }, w.tool.about)] : [])));
  }
  for (const q of w.asks ?? []) {
    box.append(h("div", { class: "asked", "data-question": "" },
      h("p", {}, q.question),
      ...(w.choose ? [] : [h("ul", {}, ...q.options.map((o) => h("li", {}, o)))])));
  }
  if (w.kind === "question" && w.choose && w.asks?.length === 1) {
    const q = w.asks[0]!;
    box.append(h("div", { class: "choices" }, ...q.options.map((o, n) => {
      const said = q.descriptions?.[n];
      const choice = h("button", { type: "button", class: "choice", "data-choice": String(n) },
        h("span", { class: "label" }, o), ...(said ? [h("span", { class: "description" }, said)] : []));
      choice.addEventListener("click", () => void hold({ choice: n }));
      return choice;
    })), composer("Type something", async (text) => (await hold({ text })) === true, { "data-reply": "" }));
  } else if (w.kind === "permission" && w.decide) {
    box.append(h("div", { class: "row" },
      pill("Deny", () => void hold({ allow: false }), "", { "data-answer": "deny" }),
      pill("Allow", () => void hold({ allow: true }), "primary", { "data-answer": "allow" })));
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
    box.append(composer("Reply", async (text) => (await hold({ text })) === true, { "data-reply": "" }));
  }
  return box;
}
