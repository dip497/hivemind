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

test("its trust and settings screens wait on the person, and say which they are", () => {
  expect(claude().detect!(TRUST)).toEqual({ status: "permission", says: "trust" });
  expect(claude().detect!(SETTINGS)).toEqual({ status: "permission", says: "settings" });
});

test("each is answered with its own keys, read from the real binary, not a permission's", () => {
  expect(claude().answer?.trust).toEqual({ allow: ["down", "enter"], deny: ["escape"] });
  expect(claude().answer?.settings).toEqual({ allow: ["3"], deny: ["escape"] });
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
