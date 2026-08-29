/**
 * Hermes (Nous Research — hermes-agent) provider transforms: session resume +
 * deterministic-signal hook injection.
 *
 * Probe results (hermes 0.20.4, binary + source greps + live runs):
 *  - Hook system: `hooks:` block in config.yaml — event → [{command, timeout}].
 *    Stdin JSON `{hook_event_name, session_id, cwd, extra:{…}}`. Shell hooks run
 *    via shlex+shell=False (NO env-prefix in the command string allowed — unlike
 *    claude, env must ride the spawn env, like droid).
 *    Events used here: pre_llm_call (turn START), post_llm_call (turn END with
 *    `extra.assistant_response` — the clean inline reply), on_session_end (turn
 *    END without the reply; fires even when the turn errored), and
 *    pre_approval_request (dangerous-command gate → "needs you").
 *  - Config-home override: `HERMES_HOME` env fully relocates the home
 *    (config.yaml, .env, auth.json, state.db, sessions). Same shape as droid's
 *    FACTORY_HOME_OVERRIDE → we seed an EPHEMERAL overlay (symlinks to the real
 *    ~/.hermes children except config.yaml, which hivemind owns — the user's own
 *    `hooks:` block, if any, is merged in) — see hcp/hermes-home.ts.
 *  - First-use hook consent: `HERMES_ACCEPT_HOOKS=1` env auto-approves + records
 *    (agent/shell_hooks.py `_prompt_and_record`) — injected at spawn, no TTY
 *    prompt in a tile. The allowlist entry lands under the OVERLAY's home, never
 *    the user's real ~/.hermes.
 *  - Session resume: `--resume <id>`, or `--in <dir> --resume latest` scoped to
 *    the workspace. Hermes itself tracks session→cwd in its store, so restore
 *    delegates resolution to `--in <cwd> --resume latest` — no session-file scan
 *    needed (unlike codex/droid/pi).
 *  - Reply path: hermes writes no claude-style transcript_path; like pi, the
 *    reply rides the turn event itself (post_llm_call's assistant_response).
 *    The turn hook source maps extra.assistant_response → text.
 */
import { basename } from "node:path";
import type { SpawnSpec } from "./pty-session-manager.js";
import { shq } from "./claude-resume.js";

export interface HermesResumeDeps {
  /** Node/electron-as-node binary that runs the hook scripts (process.execPath). */
  execPath?: string;
  /** The ephemeral HERMES_HOME overlay (per install). Set → hooks fire. */
  hermesHome?: string;
  /** Hermes-specific turn hook (hcp/hermes-stop-hook-source.ts) — maps
   *  extra.assistant_response to the inline turn text. */
  hermesStopHookPath?: string;
  /** Shared UserPromptSubmit hook script (pre_llm_call → working). */
  userpromptHookPath?: string;
  /** Hermes-specific notify hook (hcp/hermes-stop-hook-source.ts) — maps
   *  pre_approval_request to a fixed "permission" notification. */
  hermesNotifyHookPath?: string;
  /** HCP control-plane socket + capability token (injected into agent env). */
  hcpSock?: string;
  hcpToken?: string;
}

export function isHermes(spec: { cmd: string }): boolean {
  return basename(spec.cmd.trim().split(/\s+/)[0] ?? "") === "hermes";
}

/**
 * The `hooks:` config block written into the overlay's config.yaml. Commands
 * are plain (no env prefix — hermes runs them shlex'd, shell=False);
 * HIVEMIND_TILE rides the agent process env, which hermes passes through to
 * hook subprocesses. Attribution therefore can't be baked into the shared file.
 */
export function hermesHooksConfig(deps: HermesResumeDeps): Record<string, unknown[]> {
  const hooks: Record<string, unknown[]> = {};
  if (!(deps.execPath && deps.hcpSock)) return hooks;
  // hermes runs hook commands via shlex.split + shell=False — an env-prefix
  // like claude's `VAR=1 <bin>` parses as a bogus executable. Route it through
  // `env(1)`, which IS an executable. HIVEMIND_TILE needs no routing: the hook
  // subprocess inherits the agent's environment (Popen spawns with no env=),
  // and hermesEnv injects the tile id there. ELECTRON_RUN_AS_NODE=1 makes the
  // electron binary behave as plain node for the .cjs hook scripts.
  const cmd = (hookPath: string) =>
    `env ELECTRON_RUN_AS_NODE=1 ${shq(deps.execPath!)} ${shq(hookPath)} ${shq(deps.hcpSock!)}`;
  if (deps.userpromptHookPath) {
    // pre_llm_call fires at the START of each turn's first LLM call → working.
    hooks.pre_llm_call = [{ command: cmd(deps.userpromptHookPath), timeout: 10 }];
  }
  if (deps.hermesStopHookPath) {
    // post_llm_call carries extra.assistant_response → the turn event with the
    // INLINE reply (read by agent.read directly — no transcript scrape).
    hooks.post_llm_call = [{ command: cmd(deps.hermesStopHookPath), timeout: 10 }];
  }
  if (deps.hermesNotifyHookPath) {
    // pre_approval_request → deterministic "needs you" (observer hook).
    hooks.pre_approval_request = [{ command: cmd(deps.hermesNotifyHookPath), timeout: 10 }];
  }
  return hooks;
}

/** Env injected into a spawned hermes: the ephemeral home (loads OUR merged
 *  config with hooks, without touching ~/.hermes) + HCP attribution env. */
function hermesEnv(deps: HermesResumeDeps, spec: SpawnSpec, id: string): Record<string, string> | undefined {
  if (!deps.hermesHome && !(deps.hcpSock && deps.hcpToken)) return spec.env;
  const env: Record<string, string> = { ...spec.env };
  if (deps.hermesHome) {
    env.HERMES_HOME = deps.hermesHome;
    // Auto-approve OUR hook commands on first use (records into the overlay's
    // allowlist). Without it a non-TTY tile silently skips hook registration.
    env.HERMES_ACCEPT_HOOKS = "1";
  }
  if (deps.hcpSock && deps.hcpToken) {
    env.HIVE_HCP_SOCK = deps.hcpSock;
    env.HCP_TOKEN = deps.hcpToken;
    env.HIVEMIND_TILE = id; // hooks + the agent's own hive MCP attribute to this tile
    env.HIVE_AGENT_DEPTH = spec.env?.HIVE_AGENT_DEPTH ?? "0";
  }
  return env;
}

export interface HermesResumeTransforms {
  transformSpecOnSpawn: (spec: SpawnSpec, id: string) => SpawnSpec;
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
}

export function makeHermesResumeTransforms(deps: HermesResumeDeps = {}): HermesResumeTransforms {
  return {
    // Fresh spawn: no arg change (hooks come from the overlay config); inject
    // HERMES_HOME + HCP env so the deterministic hooks fire for THIS tile.
    transformSpecOnSpawn: (spec, id) => {
      if (!isHermes(spec)) return spec;
      return { ...spec, env: hermesEnv(deps, spec, id) };
    },
    // Restore: hermes resolves the newest session for the workspace itself —
    // `--in <cwd> --resume latest`. An explicit --resume/-r passes through.
    transformSpecOnRestore: (spec, id) => {
      if (!isHermes(spec)) return spec;
      const withEnv = { ...spec, env: hermesEnv(deps, spec, id) };
      const args = withEnv.args ?? [];
      if (args.includes("--resume") || args.includes("-r")) return withEnv; // already resuming
      return { ...withEnv, args: [...args, "--in", spec.cwd, "--resume", "latest"] };
    },
    // A fast death after `--resume latest` usually means the session store has
    // nothing for this cwd — strip the resume flags so the tile respawns fresh.
    restoreRetryTransform: (spec) => {
      if (!isHermes(spec)) return null;
      const args = spec.args ?? [];
      const i = args.indexOf("--resume");
      if (i < 0) return null;
      const next = args.filter((_, idx) => idx !== i && idx !== i + 1);
      const inIdx = next.indexOf("--in");
      if (inIdx >= 0) next.splice(inIdx, 2);
      return { ...spec, args: next };
    },
  };
}
