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

/**
 * Drop the one-time initial prompt from a spec's env. MUST run on every RESTORE,
 * for every agent.
 *
 * A frozen session re-execs from its persisted spec, and the spawn env is part of
 * that spec — so an un-stripped HIVE_INITIAL_PROMPT gets re-appended as a positional
 * argv and THE TASK RUNS AGAIN, every single restore. This lives here, agent-agnostic,
 * rather than inside one agent's resume provider: the strip is a property of restore
 * itself, and the version that lived in claude-resume silently did nothing for pi.
 */
export function stripInitialPrompt<T extends { env?: Record<string, string> }>(spec: T): T {
  if (!spec.env || !(INITIAL_PROMPT_ENV in spec.env)) return spec;
  const env = { ...spec.env };
  delete env[INITIAL_PROMPT_ENV];
  return { ...spec, env };
}

/**
 * Agents whose CLI takes the initial task as a POSITIONAL ARG and auto-submits it
 * as a real turn — the deterministic delivery. Everything else falls back to typing
 * the prompt into the booting TUI and hoping the Enter lands, which is the race that
 * made ▶ Work silently do nothing on a cold start.
 *
 * - claude: `claude "<prompt>"` submits in interactive mode (verified; GH #11476 asks
 *   to DISABLE this, confirming it's the behavior).
 * - pi:     `pi "<prompt>"` → main.js parses it into `initialMessage` → interactive-mode
 *   calls `session.prompt(initialMessage)` (verified in pi 0.55.3's dist).
 *
 * codex/droid/opencode are NOT here: unverified, and a wrong flag breaks their CLI.
 */
const ARGV_PROMPT_AGENTS = new Set(["claude", "pi"]);

/** Whether this agent id takes its initial prompt as argv (see ARGV_PROMPT_AGENTS). */
export function deliversPromptViaArgv(agentId: string | undefined | null): boolean {
  return !!agentId && ARGV_PROMPT_AGENTS.has(agentId);
}
