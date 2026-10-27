// Claude's own startup screens wait for the person, and say which they are, so a phone or a
// program answers each with its own keys. Screens as claude 2.1.296 draws them (rendered from a
// real session).
import { expect, test } from "bun:test";
import { authoredDefs } from "./authored.js";

const claude = () => authoredDefs().find((d) => d.id === "claude")!;

const TRUST = [
  "────────────────────────────────────────────────────────────────────────────────",
  " Accessing workspace:", "", " /tmp/new-project", "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a",
  " well-known open source project, or work from your team). If not, take a moment to review what's in",
  " this folder first.", "", " Claude Code'll be able to read, edit, and execute files here.", "", " Security guide", "",
  " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel",
].join("\n");

const SETTINGS = [
  "────────────────────────────────────────────────────────────────────────────────",
  "  Settings Error", "", "  /tmp/new-project/.claude/settings.json", "  └ Invalid or malformed JSON", "",
  "  Files with errors are skipped entirely, not just the invalid settings.", "",
  "  ❯ 1. Fix with Claude", "    2. Exit and fix manually", "    3. Continue without these settings", "",
  "  Enter to confirm · Esc to cancel",
].join("\n");

// Rendered from claude 2.1.302 with an invalid rule in the folder's .claude/settings.local.json.
const SETTINGS_WARNING = [
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  Settings Warning", "", "  /tmp/new-project/.claude/settings.local.json",
  "  └ permissions.allow: Invalid permission rule \"Bash(foo:*\" was skipped: Malformed Tool(content) rule. Rules",
  "    take the form Tool or Tool(content) and must end at the closing \")\"; parentheses inside the content are",
  "    literal", "", "  The values listed above were skipped; the rest of the file is in effect.", "",
  "  ❯ 1. Continue", "    2. Fix with Claude", "    3. Exit and fix manually", "",
  "  Enter to confirm · Esc to cancel",
].join("\n");

// Its unattended mode's warning, laid out from the text in the claude 2.1.302 binary (the screen
// itself was not rendered here): the title, what it warns, and its two options.
const BYPASS = [
  "────────────────────────────────────────────────────────────────────────────────",
  "  WARNING: Claude Code running in Bypass Permissions mode", "",
  "  In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially",
  "  dangerous commands.",
  "  This mode should only be used in a sandboxed container/VM that has restricted internet access and can",
  "  easily be restored if damaged.", "",
  "  By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.", "",
  "  ❯ 1. No, exit", "    2. Yes, I accept", "",
  "  Enter to confirm · Esc to cancel",
].join("\n");

test("its trust, settings, settings-warning and bypass screens wait on the person, and say which they are", () => {
  expect(claude().detect!(TRUST)).toEqual({ status: "permission", says: "trust" });
  expect(claude().detect!(SETTINGS)).toEqual({ status: "permission", says: "settings" });
  expect(claude().detect!(SETTINGS_WARNING)).toEqual({ status: "permission", says: "settings-warning" });
  expect(claude().detect!(BYPASS)).toEqual({ status: "permission", says: "bypass" });
});

test("each is answered with its own keys, read from the real binary, not a permission's", () => {
  expect(claude().answer?.trust).toEqual({ allow: ["down", "enter"], deny: ["escape"] });
  expect(claude().answer?.settings).toEqual({ allow: ["3"], deny: ["escape"] });
  expect(claude().answer?.["settings-warning"]).toEqual({ allow: ["1"], deny: ["3"] });
  // Accepting the bypass warning is the person's consent: nothing answers it from afar.
  expect(claude().answer?.bypass).toBeUndefined();
  expect(claude().answer?.permission).toEqual({ allow: ["1"], deny: ["escape"] });
});

test("a chooser that is neither is still a question, saying nothing", () => {
  expect(claude().detect!(" Select model\n ❯ 1. Default\n   2. Opus\n Enter to confirm · Esc to cancel")).toEqual({ status: "question" });
});

// AskUserQuestion's chooser as the daemon reads it while a viewer's repaint shrinks the screen a
// row: its footer is cut, and the person's last message above starts with the prompt's mark.
const CHOOSER_CUT = [
  "✻ Baked for 7s · done 1:06 AM", "",
  "❯ ask me a question", "  ⎿  1 skill available",
  "───────────────────────────────────────────────────────────────────────────────",
  " ☐ Next line ", "", "Which line should I add to hello.txt next?", "",
  "❯ 1. Nothing", "     Leave hello.txt as it is",
  "  2. A timestamp", "     Add today's date and time as a new line",
  "  3. \"test passed\"", "     Add the line \"test passed\"",
  "  4. Type something.",
  "───────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this", "",
].join("\n");

test("a numbered option under the mark is a chooser waiting on the person, not its prompt, footer or not", () => {
  expect(claude().detect!(CHOOSER_CUT)).toEqual({ status: "question" });
  expect(claude().detect!(CHOOSER_CUT.replace("❯ 1. Nothing", "  1. Nothing").replace("  2. A timestamp", "❯ 2. A timestamp"))).toEqual({ status: "question" });
  expect(claude().detect!("✻ Baked for 7s\n\n❯ ask me a question\n  ⎿  done\n\n❯ \n")).toEqual({ status: "idle" });
});

// The person's message starts with a number, and Claude works on it.
const WORKING_ON = (message: string) => [
  "✻ Crunched for 8m 1s · done 11:50 AM", "",
  `❯ ${message}`, "",
  "  Calling plugin:context-mode:context-mode · 58s…", "",
  "✶ Kneading… (1m 9s · ↓ 619 tokens)", "  ⎿  Tip: Use /statusline to set up a custom status line", "",
  "───────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "───────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt",
].join("\n");

test("a message that starts with a number is not a chooser's option, while Claude works on it or after", () => {
  expect(claude().detect!(WORKING_ON("25.04.1+1 GA check this version"))).toEqual({ status: "working" });
  expect(claude().detect!(WORKING_ON("1. fix the login, 2. then the logout"))).toEqual({ status: "working" });
  expect(claude().detect!("✻ Baked for 7s\n\n❯ 1. fix the login\n  ⎿  done\n\n❯ \n")).toEqual({ status: "idle" });
});
