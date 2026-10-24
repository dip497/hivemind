// When an agent's wait may be allowed or denied with one click from its row or toast
// (wait-decide.tsx, docs/design/last-line-2026-10-23.md §2): only a permission its agent says the
// keys of, for a tool whose input is known, so the person always has the input to read first; and
// only when all of that input is in one line that shows it, decided on the text the agent wrote.
// Else Review shows it whole, its line breaks kept. A view's line slot offers Review alone, naming
// the tile: the view places the slot, and could place Allow under the person's pointer. A new wait gets buttons of its own, which take
// no press in their first half second, so a click meant for one prompt never answers the next.
//
// The buttons are drawn into a DOM (linkedom), which is set up before the module is loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { parseHTML } from "linkedom";
import type { AgentWait } from "../../src/renderer/src/agent-waits.ts";

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
/** What the bridge was asked to answer. */
const answered: Array<{ tile: string; since: number; decision: string }> = [];
Object.assign(dom.window, {
  innerWidth: 1280, innerHeight: 800,
  hive: {
    agentAnswer: async (tile: string, since: number, a: { decision: string }) => { answered.push({ tile, since, decision: a.decision }); return { answered: true }; },
    onTileLines: () => () => {},
    tileLinesWatch: async () => ({ lines: {} }),
  },
});
(dom.window.HTMLElement.prototype as unknown as { getBoundingClientRect(): object }).getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 28, right: 60, width: 60, height: 28 });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true });

const { createRoot } = await import("react-dom/client");
const { ARM_MS, decidable, DecideButtons, inSight, reviewText, REVIEW_MAX } = await import("../../src/renderer/src/wait-decide.tsx");
const { LineSlots } = await import("../../src/renderer/src/workspace/views/community/line-slots.tsx");
const { tellAgent } = await import("../../src/renderer/src/agent-waits.ts");

const wait = (w: Omit<AgentWait, "since">, since = 1): AgentWait => ({ since, ...w });

test("Allow and Deny are offered only for a permission its agent decides, of a tool whose input is known", () => {
  const rows: Array<[string, AgentWait | undefined, boolean]> = [
    ["a permission decided from here, its command known", wait({ kind: "permission", decide: true, tool: { name: "Bash", about: "npm test" } }), true],
    ["its agent says no keys that decide it", wait({ kind: "permission", tool: { name: "Bash", about: "npm test" } }), false],
    ["no tool known: nothing to read before allowing", wait({ kind: "permission", decide: true }), false],
    ["a tool whose input is not known", wait({ kind: "permission", decide: true, tool: { name: "Bash" } }), false],
    ["an input of blanks", wait({ kind: "permission", decide: true, tool: { name: "Bash", about: "  \n " } }), false],
    ["a question is answered, not allowed", wait({ kind: "question", decide: true, tool: { name: "AskUserQuestion", about: "Which?" } }), false],
    ["a supervised approval is its lead's", wait({ kind: "approval", decide: true, tool: { name: "Bash", about: "npm test" } }), false],
    ["no wait", undefined, false],
  ];
  for (const [what, waiting, offered] of rows) assert.equal(decidable(waiting), offered, what);
});

test("Allow in one click only when all of what runs is one short line of plain text as the agent wrote it", () => {
  const rows: Array<[string, string, boolean]> = [
    ["one line", "npm test", true],
    ["blanks around it", "  npm test \n", true],
    ["160 characters", `echo ${"x".repeat(155)}`, true],
    ["161 characters: a line would cut it", `echo ${"x".repeat(156)}`, false],
    ["a line feed", "npm test\nrm -rf ~", false],
    ["a carriage return", "npm test\rrm -rf ~", false],
    ["a vertical tab", "npm test\vrm -rf ~", false],
    ["a form feed", "npm test\frm -rf ~", false],
    ["a line separator", "npm test rm -rf ~", false],
    ["a paragraph separator", "npm test rm -rf ~", false],
    ["a next line (C1)", "npm test\u0085rm -rf ~", false],
    ["a tab", "npm\ttest", false],
    ["a bell a line strips", "npm test\u0007", false],
    ["a run of spaces that pushes the rest away", `npm test${" ".repeat(150)}; rm -rf ~`, false],
    ["two spaces", "npm  test", false],
    ["a right-to-left override", "rm -rf ‮build‬", false],
    ["a zero-width space", "rm -rf /​tmp", false],
    ["a zero-width joiner", "rm‍ -rf", false],
    ["a blank Hangul filler", "rm -rf ㅤ", false],
  ];
  for (const [what, about, offered] of rows) assert.equal(inSight(about), offered, what);
});

test("a review shows what runs as the agent wrote it, its line breaks kept and no line cut, controls and bidi out; and says when it may be longer than it shows", () => {
  const long = "y".repeat(300);
  assert.deepEqual(reviewText(`npm test\r\n${long} rm -rf ‮build‬\u0007​\n\n`), { text: `npm test\n${long}\nrm -rf build`, more: false });
  assert.deepEqual(reviewText("a\tb"), { text: "a\tb", more: false }, "a tab stays");
  const huge = reviewText("z".repeat(REVIEW_MAX + 10));
  assert.deepEqual([huge.text.length, huge.more], [REVIEW_MAX, true]);
});

/** Each button of the band drawn into `host`, by what it does. */
const buttons = (host: { querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null }> }) =>
  Array.from(host.querySelectorAll("[data-decide]")).map((b) => b.getAttribute("data-decide"));
const press = (el: unknown) => (el as { dispatchEvent(e: unknown): void }).dispatchEvent(new dom.window.Event("click", { bubbles: true }));
const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

test("a new wait in place of another gets buttons of its own: a press in their first half second answers nothing, and an open Review closes", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as never);
  const first = wait({ kind: "permission", decide: true, tool: { name: "Bash", about: "npm test" } }, 1);
  const next = wait({ kind: "permission", decide: true, tool: { name: "Bash", about: "rm -rf ~" } }, 2);
  const band = (w: AgentWait, cut = false) => act(async () => { root.render(createElement(DecideButtons, { tile: "t1", waiting: w, cut })); });

  await band(first);
  assert.deepEqual(buttons(host), ["deny", "allow"]);
  await sleep(ARM_MS + 50);
  await band(next);
  await act(async () => { press(host.querySelector('[data-decide="allow"]')); });
  assert.deepEqual(answered, [], "pressed as the next wait took the first's place: nothing answered");
  await sleep(ARM_MS + 50);
  await act(async () => { press(host.querySelector('[data-decide="allow"]')); });
  assert.deepEqual(answered, [{ tile: "t1", since: 2, decision: "allow" }]);

  // A Review open on one wait closes as another takes its place.
  answered.length = 0;
  await band(wait({ kind: "permission", decide: true, tool: { name: "Bash", about: "npm test\nnpm run lint" } }, 3));
  await act(async () => { press(host.querySelector('[data-decide="review"]')); });
  assert.equal(dom.document.querySelectorAll("[data-wait-review]").length, 1);
  await band(wait({ kind: "permission", decide: true, tool: { name: "Bash", about: "git push\ngit push --force" } }, 4));
  assert.equal(dom.document.querySelectorAll("[data-wait-review]").length, 0);
  await act(async () => { root.unmount(); });
});

test("a view's line slot offers Review alone, never Allow, however short what runs; its review names the tile", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as never);
  tellAgent({ tile: "t9", waiting: wait({ kind: "permission", decide: true, tool: { name: "Bash", about: "npm test" } }, 7) } as never);
  await act(async () => {
    root.render(createElement(LineSlots, { rects: [{ tileId: "t9", x: 0, y: 0, w: 400, h: 28 }], box: { w: 800, h: 600 }, names: new Map([["t9", "api: claude"]]) }));
  });
  assert.deepEqual(buttons(host), ["review"]);
  await act(async () => { press(host.querySelector('[data-decide="review"]')); });
  const review = dom.document.querySelector("[data-wait-review]")!;
  assert.equal(review.getAttribute("aria-label"), "Allow Bash in api: claude?");
  assert.deepEqual(buttons(review), ["deny", "allow"]);
  await act(async () => { root.unmount(); });
});
