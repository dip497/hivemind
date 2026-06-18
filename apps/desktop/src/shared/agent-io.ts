/**
 * Delay (ms) between typing text into an agent's TUI and the SEPARATE Enter
 * keystroke. claude's input loop drops a newline that arrives in the same write
 * as the text, so Enter must be its own write this long after (the tmux
 * `send-keys` pattern). One constant so the delivery sites — HCP agent.send /
 * agent.report / pipe-forward (main) and the renderer's prompt delivery — can't
 * drift apart.
 */
export const SUBMIT_DELAY_MS = 90;
