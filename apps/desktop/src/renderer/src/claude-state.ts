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

  if (/esc to interrupt/i.test(last)) return "working";

  // Idle: the prompt line (❯ + space/nbsp, not followed by a digit).
  if (/^❯[\s\xa0](?![\d])/m.test(last)) return "idle";
  // Idle: Claude Code splash / welcome screen.
  if (/⏵⏵\s*bypass permissions/i.test(last)) return "idle";

  return "working";
}
