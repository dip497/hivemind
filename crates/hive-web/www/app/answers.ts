// The answers to what an agent waits on (spec/needs.md "Answering"), as the Android app's
// Answering.kt has them: Allow and Deny for a permission its device can decide, Approve or Ask for
// changes for a plan, and a line of reply for anything else. One place for the Needs you list and
// the agent's own screen.

import { composer, h, pill } from "./dom.js";
import { markdown } from "./markdown.js";
import type { Reply, Waiting } from "./types.js";

export function answers(w: Waiting, answer: (reply: Reply) => Promise<boolean>): HTMLElement {
  const box = h("div", { class: "answers" });
  // Answering, or reading the plan, is not opening the agent.
  box.addEventListener("click", (e) => e.stopPropagation());
  // One answer at a time.
  const hold = async (reply: Reply) => {
    box.inert = true;
    try {
      return await answer(reply);
    } finally {
      box.inert = false;
    }
  };
  if (w.kind === "permission" && w.decide) {
    box.append(h("div", { class: "row" },
      pill("Deny", () => void hold({ allow: false }), "", { "data-answer": "deny" }),
      pill("Allow", () => void hold({ allow: true }), "primary", { "data-answer": "allow" })));
  } else if (w.kind === "plan") {
    const plan = w.plan ? h("div", { class: "plan", hidden: true, "data-plan": "" }, ...markdown(w.plan)) : null;
    const read = plan && pill("Read the plan", () => {
      plan.hidden = false;
      read!.hidden = true;
    }, "", { "data-answer": "plan" });
    const changes = composer("What to change", (feedback) => hold({ approve: false, feedback }), { "data-changes": "" });
    changes.hidden = true;
    const ask = pill("Ask for changes", () => {
      changes.hidden = false;
      ask.hidden = true;
      changes.querySelector("textarea")!.focus();
    }, "", { "data-answer": "changes" });
    box.append(...[plan, changes, read].filter((e) => e !== null), h("div", { class: "row" },
      ask, pill("Approve", () => void hold({ approve: true }), "primary", { "data-answer": "approve" })));
  } else {
    box.append(composer("Reply", (text) => hold({ text }), { "data-reply": "" }));
  }
  return box;
}
