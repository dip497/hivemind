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

/**
 * Spawn-env key carrying an agent's INITIAL prompt (a ▶ Work / spawn-with-work
 * task). It is delivered as claude's positional `[prompt]` ARGV, which claude
 * auto-submits — sidestepping the boot-time TUI race that swallowed a typed
 * prompt's Enter (the "▶ Work silently did nothing" bug). It rides the spawn env
 * because env already crosses the renderer→main→daemon wire and persists in the
 * snapshot; it is stripped on frozen-restore (claude-resume) so a re-exec never
 * re-submits the task.
 */
export const INITIAL_PROMPT_ENV = "HIVE_INITIAL_PROMPT";

/**
 * Consume {@link INITIAL_PROMPT_ENV} from a spawn env at exec time. Returns argv
 * with the prompt appended as claude's trailing positional (auto-submits) and the
 * env with the key removed so the child process never sees a stray var. A no-op
 * when the key is absent, so every spawn can call it unconditionally.
 *
 * Pure + argv-array based (never a shell string), so the prompt can't be
 * word-split or shell-injected — it reaches claude as one argv element verbatim.
 */
export function applyInitialPrompt(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): { args: string[]; env: Record<string, string> } {
  const prompt = env[INITIAL_PROMPT_ENV];
  if (!prompt) return { args: [...args], env: { ...env } };
  const next = { ...env };
  delete next[INITIAL_PROMPT_ENV];
  return { args: [...args, prompt], env: next };
}
