/**
 * Spawn-env key carrying an agent's INITIAL prompt (a ▶ Work / spawn-with-work
 * task). An agent whose manifest says `promptDelivery: argv` takes it as its positional
 * prompt ARGV, which it submits itself — no race against a booting TUI dropping a typed
 * Enter. It rides the spawn env because env already crosses the renderer→main→daemon wire
 * and persists in the snapshot; it is stripped on restore so a re-exec never re-submits it.
 */
export const INITIAL_PROMPT_ENV = "HIVE_INITIAL_PROMPT";

/**
 * Consume {@link INITIAL_PROMPT_ENV} from a spawn env at exec time. Returns argv
 * with the prompt appended as the trailing positional (the agent submits it) and the
 * env with the key removed so the child process never sees a stray var. A no-op
 * when the key is absent, so every spawn can call it unconditionally.
 *
 * Pure + argv-array based (never a shell string), so the prompt can't be
 * word-split or shell-injected — it reaches the agent as one argv element verbatim.
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
 * argv and THE TASK RUNS AGAIN, every single restore. The strip is a property of restore
 * itself, so it lives here for every agent rather than in any one agent's resume.
 */
export function stripInitialPrompt<T extends { env?: Record<string, string> }>(spec: T): T {
  if (!spec.env || !(INITIAL_PROMPT_ENV in spec.env)) return spec;
  const env = { ...spec.env };
  delete env[INITIAL_PROMPT_ENV];
  return { ...spec, env };
}
