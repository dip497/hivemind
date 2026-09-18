// The screens every detector is judged on: hand-picked shapes plus deterministic fuzz built
// from the rules' own literals. Seeded, and built from the agents in the bundle in sorted
// order — the pool feeds the shuffle, so anything order-dependent (a directory listing, a
// stray file a test left behind) would quietly change every hash in detector-golden.json.
import { AUTHORED, authoredYaml } from "./authored.js";

// Shapes fuzzing won't produce; without them some rules are never exercised.
export const SEEDS = [
  "↑ 1.2k tokens", "↓ 18.3k tokens", "(1.2k tokens", "· 900 tokens", "↑ 12 tokens",
  "• Working (0s • esc…", "  • Working (12s)", "• working (0s)",
  "✻ Thinking… (esc to interrupt)", "⠋ Reading files… esc to interrupt",
  "x\n  1. No\n  2. Yes, allow", "Pick:\n↑/↓ to navigate", "❯ ",
  "(6m 41s · thinking)", "(12s · 1.2k tokens)", "⏵⏵ bypass permissions",
  "⏵⏵ accept edits\n│ box", "waiting for 3 background agents to finish",
  "⬡ Generating…", "⬢ Thinking...", "⠿ Searching…", "◔ analysing esc to cancel",
  "  (y) allow", "run (once) (y)", "→ run (y)", "△ Permission required",
  "/tasks 3 tasks", "/tasks 0 tasks", "  tab amend\nrequesting permission for:",
  "EXECUTE\n> yes, allow", "kiro is working", "cline is ready for your message",
  "[act mode] yes", "let cline use this tool", "Working...",
  // A prompt with nothing after it: the shape the fuzz cannot make, because its tokens
  // carry their own trailing space. A rule that leaned on a regex's `\s` matching the
  // newline read these as idle and its replacement did not — caught end to end, not here.
  "❯", "out\n❯", "❯\n", "> ", ">", "done\n> ",
];

// ── corpus: seeds + deterministic fuzz from the rules' own literals
function corpusFor(): string[] {
  const pool = new Set<string>([
    "", " ", "foo bar", "❯ ", "> ", "│ ", "  ", "src/index.ts",
    "esc to interrupt", "esc to cancel", "esc to stop", "ctrl+c to stop",
    "do you want to proceed?", "would you like to continue", "yes", "no",
    "[y/n]", "(y/n)", "(y) (enter)", "allow", "deny", "trust", "reject",
    "2. Yes, allow", "1. No", "Press Enter", "Enter to select", "↑/↓ to navigate",
    "⏵⏵ accept edits", "waiting for 2 background agents", "1.2k tokens", "(12s ·",
    "⠋ Reading files…", "⬡ Thinking...", "◔ running", "• Working (0s)",
    "△ Permission required", "↑↓ select", "⇆ tab", "esc dismiss", "enter confirm",
    "/tasks 3 tasks", "/tasks 0 task", "requesting permission for:", "tab amend",
    "Working...", "EXECUTE", "> yes, allow", "kiro is working", "run (once)",
    "waiting for approval", "approve", "deny with feedback", "invoke tool",
    "let cline use this tool", "[act mode]", "cline is ready for your message",
    "thinking", "processing", "msg=interrupt", "ctrl+c cancel", "ctrl+o:yolo",
    "✻ Cogitating…", "confirm with", "enter",
  ]);
  // Every agent we wrote, not whatever files are in a directory: a stray manifest left
  // behind by a test would otherwise change the corpus, and with it every hash this suite
  // exists to hold still. Sorted, because the pool feeds a seeded shuffle.
  for (const agent of AUTHORED) {
    for (const m of authoredYaml(agent).matchAll(/contains(?:CS)?: (.+)/g)) {
      pool.add(m[1]!.replace(/^["']|["']$/g, ""));
    }
  }
  const POOL = [...pool];
  let seed = 20260910;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out: string[] = [...SEEDS];
  for (let i = 0; i < 8000; i++) {
    const lines: string[] = [];
    const n = 1 + Math.floor(rnd() * (rnd() < 0.2 ? 26 : 5));
    for (let j = 0; j < n; j++) {
      let l = "";
      for (let t = 0, k = 1 + Math.floor(rnd() * 3); t < k; t++) {
        let tok = POOL[Math.floor(rnd() * POOL.length)]!;
        if (rnd() < 0.2) tok = tok.toUpperCase();
        l += tok + (rnd() < 0.7 ? " " : "");
      }
      if (rnd() < 0.25) l = "  " + l;
      if (rnd() < 0.08) l = "";
      lines.push(l);
    }
    out.push(lines.join("\n"));
  }
  return out;
}

export const CORPUS = corpusFor();
