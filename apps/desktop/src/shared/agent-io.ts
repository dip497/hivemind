/**
 * Delay (ms) between typing text into an agent's TUI and the SEPARATE Enter
 * keystroke. claude's input loop drops a newline that arrives in the same write
 * as the text, so Enter must be its own write this long after (the tmux
 * `send-keys` pattern). One constant so the delivery sites — HCP agent.send /
 * agent.report / pipe-forward (main) and the renderer's prompt delivery — can't
 * drift apart.
 */
export const SUBMIT_DELAY_MS = 90;

/**
 * Backstop delay (ms) for the INITIAL spawn prompt only. A freshly-booted claude
 * TUI sometimes drops the first Enter — it arrives before the paste-debounce of
 * the just-rendered input settles, so the prompt is typed but never submitted and
 * the user has to press Enter by hand. We re-send Enter once at this longer delay,
 * but ONLY if the agent is still idle (never submitted) — so a prompt that already
 * went through never gets a stray second Enter. Long enough that a poll tick has
 * run and reflected "working" if the first Enter did land.
 */
export const SPAWN_SUBMIT_RETRY_MS = 1500;
