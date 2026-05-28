/**
 * Claude Code session-state detection by screen scraping — ported verbatim from
 * 49agents (agent/services/tmux.js `detectClaudeState`, BSL-1.1). Instead of
 * `tmux capture-pane` we feed it xterm's rendered viewport; the regexes are
 * identical. Lets hivemind show working / waiting-for-approval / waiting-for-
 * input / idle on every Claude tile with NO Claude Code hooks or config.
 */
export type ClaudeState = "permission" | "question" | "working" | "idle";

export function detectClaudeState(screen: string): ClaudeState {
  const lines = screen.split("\n");
  // Strip trailing empty lines so "last 20" reflects real content.
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const last = lines.slice(-20).join("\n");

  // Tool-use permission dialog — always renders a numbered "2. Yes, ..." choice.
  // Anchoring on that avoids false positives from conversational "do you want…".
  if (/^\s*2\.\s+Yes,\s/m.test(last)) return "permission";

  // Interactive question / selection prompts (line-anchored to avoid prose).
  if (
    /^\s*Press Enter/im.test(last) ||
    /Enter to select/i.test(last) ||
    /↑\/↓ to navigate/.test(last) ||
    /Esc to cancel/i.test(last) ||
    /\[use arrows/i.test(last)
  ) {
    return "question";
  }

  // Working — checked BEFORE idle because the input prompt (❯) stays visible
  // while Claude works (you can queue input), so an idle-prompt match must not
  // win over an active-work signal. Two signals, either ⇒ working:
  //   1. the interrupt hint ("(esc to interrupt …)") on the status line.
  //   2. the animated spinner glyph + a present-progressive "…" gerund, e.g.
  //      "✻ Cogitating…", "* Forging…", "✳ Crunching…". This catches versions /
  //      states where the interrupt hint scrolls out but the spinner is live.
  //      (Spinner glyphs Claude cycles: ✻ ✶ ✳ ✢ ✽ ⋆ ● * · — match any, then a
  //      word, then the ellipsis. Box-drawing prefixes like "│ " are tolerated.)
  if (/esc to interrupt/i.test(last)) return "working";
  if (/[✻✶✳✢✽⋆●*·]\s+\w[\w' -]*…/u.test(last)) return "working";

  // Idle: the prompt line (❯ or > + space/nbsp, not followed by a digit) AND no
  // active-work signal above. `>` covers newer prompt rendering.
  if (/^[❯>][\s\xa0](?![\d])/m.test(last)) return "idle";
  // Idle: Claude Code splash / welcome screen (persistent mode footer alone is
  // NOT treated as idle — it shows during work too — only the splash variant).
  if (/⏵⏵\s*(bypass permissions|accept edits)/i.test(last) && !/[│╭╰]/.test(last)) return "idle";

  return "working";
}
