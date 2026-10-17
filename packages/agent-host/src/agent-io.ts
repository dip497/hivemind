import { agentById } from "@hivemind/agents";
/**
 * Delay (ms) between typing text into an agent's TUI and the SEPARATE Enter
 * keystroke. A TUI's input loop can drop a newline that arrives in the same write
 * as the text, so Enter must be its own write this long after (the tmux
 * `send-keys` pattern). One constant so the delivery sites — HCP agent.send /
 * agent.report / pipe-forward (the host) and the window's prompt delivery — can't
 * drift apart.
 */
export const SUBMIT_DELAY_MS = 90;

/**
 * How often (ms) the INITIAL spawn prompt's Enter is pressed again while the agent is still idle.
 * A freshly-booted agent TUI can drop Enters until its input settles, so the prompt sits typed but
 * never submitted. Long enough that a poll tick has run and reflected "working" if one did land.
 */
export const SPAWN_SUBMIT_RETRY_MS = 1500;

/**
 * Whether this agent takes its initial prompt as a POSITIONAL ARG the CLI
 * auto-submits (deterministic delivery) — declared per provider in the catalog
 * (`caps.promptDelivery`). Everything else falls back to typing the prompt into
 * the booting TUI once it reads idle.
 */
export function deliversPromptViaArgv(agentId: string | undefined | null): boolean {
  return agentById(agentId)?.caps.promptDelivery === "argv";
}
