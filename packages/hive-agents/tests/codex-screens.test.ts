// Codex's own startup prompts wait for the user; read as idle, a message sent to the tile
// would answer them. Screens as Codex draws them (rendered from a real session).
import { expect, test } from "bun:test";
import { authoredDefs } from "./authored.js";
import { agentDisclosures } from "../src/manifest.js";

const codex = () => authoredDefs().find((d) => d.id === "codex")!;

test("Codex's hooks review and update prompt read as waiting for the user", () => {
  const review = [
    "  Hooks need review", "  11 hooks are new or changed.", "  Hooks can run outside the sandbox after you trust them.",
    "› 1. Review hooks", "  2. Trust all and continue", "  3. Continue without trusting (hooks won't run)", "  enter confirm · esc skip",
  ].join("\n");
  const update = [
    "  ✨ Update available! 0.155.1 -> 0.157.1", "  Release notes: https://github.com/openai/codex/releases/latest",
    "› 1. Update now (runs `npm install -g @openai/codex`)", "  2. Skip", "  3. Skip until next version", "  Press Enter to continue.",
  ].join("\n");
  expect(codex().detect!(review)).toBe("blocked");
  expect(codex().detect!(update)).toBe("blocked");
  expect(codex().detect!("› Explain this codebase\n\n  gpt-5 high · 100% left")).toBe("idle");
});

test("the hook review it opens on a first run reads as waiting, on both of its screens", () => {
  expect(codex().detect!([
    "  Hooks", "  Lifecycle hooks from config and enabled plugins.",
    "  ⚠ 11 hooks need review before they can run.", "  Event                 Installed   Active",
    "↓ t trust all · enter review · esc close",
  ].join("\n"))).toBe("blocked");
  expect(codex().detect!([
    "  PostToolUse hooks", "  1 hook needs review before it can run.",
    "› [x] Hook 1", "  [!] Hook 2 · modified", "  space/enter toggle · esc back",
  ].join("\n"))).toBe("blocked");
});

test("tiles Hivemind starts skip the startup update check and keep the wheel", () => {
  expect(codex().launch?.args).toEqual([
    "-c", "check_for_update_on_startup=false",
    "-c", "tui.fullscreen_transcript=false",
    "--dangerously-bypass-hook-trust",
  ]);
});

test("waiving its hook review is disclosed, because it waives the review of your own hooks too", () => {
  const lines = agentDisclosures(codex());
  expect(lines.some((l) => l.includes("hook review waived"))).toBe(true);
});

test("what it is printing is not what it is asking: a working screen quoting a question stays working", () => {
  // The kind of thing it streams while it works — a plan, a file, a transcript — full of the
  // words a confirmation is made of. Only the live prompt area at the bottom decides.
  const streaming = [
    "  Reading docs/design/pin-and-order.md", "  > Do you want to keep the old flag? Yes, if it is cheap.",
    "  > [y/n] in the manual means it wants an answer", "  applying patch to apps/desktop/src/App.tsx",
    "", "• Working (23s • Esc to interrupt)",
  ].join("\n");
  expect(codex().detect!(streaming)).toBe("working");
  // And a real prompt, at the bottom where it lives, still reads as waiting.
  expect(codex().detect!(`${streaming}\n  Allow command?\n› 1. Yes (y)\n  2. No`)).toBe("blocked");
});
