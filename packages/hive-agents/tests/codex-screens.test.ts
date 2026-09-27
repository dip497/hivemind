// Codex's own startup prompts wait for the user; read as idle, a message sent to the tile
// would answer them. Screens as Codex draws them (rendered from a real session).
import { expect, test } from "bun:test";
import { authoredDefs } from "./authored.js";

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

test("tiles Hivemind starts skip Codex's startup update check", () => {
  expect(codex().launch?.args).toEqual(["-c", "check_for_update_on_startup=false"]);
});
