/**
 * Kiro CLI (kiro-cli) provider transforms: session resume AND deterministic-
 * signal hook injection. kiro-cli ships a hook system with claude's vocabulary
 * (docs/cli/hooks + docs/cli/custom-agents/configuration-reference):
 * `agentSpawn` / `userPromptSubmit` / `preToolUse` / `postToolUse` / `stop`,
 * delivered as JSON on stdin (`hook_event_name`, `cwd`, `session_id`,
 * `tool_name`, `tool_input`), with `preToolUse` able to BLOCK a tool via exit
 * code 2 (docs/cli/reference/exit-codes) and `stop` able to refuse the stop via
 * `{"decision":"block","reason":"…"}` on stdout. So kiro is a first-class hook
 * provider, not scrape-only — same tier as droid.
 *
 * Injection seam — kiro has no inline `--settings` flag. Its hooks (+ mcpServers
 * + allowedTools) live in a NAMED custom-agent config file, `<KIRO_HOME>/.kiro/
 * agents/<name>.json`, selected at spawn with `--agent <name>` (docs/cli/custom-
 * agents/configuration-reference). `KIRO_HOME` overrides `~/.kiro` wholesale
 * (agents, prompts, skills, steering, settings, sessions — the same seam
 * `FACTORY_HOME_OVERRIDE` gives droid), so hivemind points kiro at an EPHEMERAL
 * per-install home (seeded with symlinks to the user's real ~/.kiro for
 * auth/settings/sessions/custom agents + our own `agents/hivemind.json`) — the
 * user's real ~/.kiro is never touched. See hcp/kiro-home.ts for the seeding.
 * Because that home (and thus hivemind.json) is SHARED across kiro tiles,
 * per-tile attribution can't live in the static hook command — it rides the
 * spawn ENV (`HIVEMIND_TILE`), which the shared hook scripts already read (see
 * droid-resume.ts) and kiro is assumed to pass through to its hook subprocesses,
 * exactly like droid does (unverified for kiro specifically — no kiro-cli binary
 * available to confirm env inheritance into hook children; modeled on droid's
 * confirmed-working pattern as the safer default).
 *
 * ASSUMPTION (flagged per the maintainer's audit, unverifiable without the
 * binary): the shared HCP `stop` hook script reads `evt.transcript_path` from
 * the hook's stdin JSON (see hcp/stop-hook-source.ts, shared verbatim with
 * droid/claude). If kiro's `stop` payload does NOT carry a `transcript_path`
 * field, the "turn" event we forward to HCP simply carries `transcriptPath:
 * null` — `agent.read`/`hive_workflow` degrade to the timeout-based gather path
 * instead of a clean transcript read, but nothing breaks. Same fallback droid
 * already relies on if its own transcript_path assumption were ever wrong.
 *
 * Session addressing: kiro's hook payload hands us `session_id` directly (per
 * the maintainer's audit of docs/cli/hooks), so — UNLIKE droid/codex, which have
 * to scan a session store for the newest entry matching cwd — a kiro tile can be
 * bound to ITS OWN session id, captured off the first hook event that fires and
 * recorded via the SAME per-tile tracker (`tile-session-store.ts` / the shared
 * `tile-session-tracker.cjs`, currently written for claude's SessionStart hook —
 * its stdin-reading logic is generic: it only expects `{ session_id }` at the
 * top level, so it's reused as-is for kiro's `agentSpawn`/`userPromptSubmit`
 * events). Restore then uses `--resume-id <tracked-id>` — no cwd collision
 * between two kiro tiles in the same directory. Falls back to bare `--resume`
 * (kiro's own newest-session-for-cwd) when no session id was ever captured
 * (e.g. the daemon restarted before the tile's first hook fired).
 */
import { basename } from "node:path";
import type { SpawnSpec } from "./pty-session-manager.js";
import { readTrackedSession } from "./tile-session-store.js";
import { shq } from "./claude-resume.js";

/** The name of the custom agent config hivemind writes into the KIRO_HOME
 *  overlay (`agents/hivemind.json`) and selects at spawn with `--agent`. */
export const KIRO_HIVEMIND_AGENT = "hivemind";

export interface KiroResumeDeps {
  /** Node/electron-as-node binary that runs the hook + tracker scripts. */
  execPath?: string;
  /** The ephemeral KIRO_HOME overlay target (per install). Set → hooks fire and
   *  `--agent hivemind` is selected at spawn. */
  kiroHome?: string;
  /** Shared HCP hook scripts (the SAME .cjs files claude/droid use). */
  stopHookPath?: string;
  userpromptHookPath?: string;
  /** kiro-specific PreToolUse broker (exit-code/stdout contract differs from
   *  claude's — see hcp/kiro-approval-hook-source.ts). Only fires when the
   *  spawn env carries HIVE_SUPERVISE (checked by the script itself, inherited
   *  from kiroEnv — see providers/kiro.ts docblock). */
  kiroApprovalHookPath?: string;
  /** Shared per-tile session tracker `.cjs` (tile-session-store.ts's
   *  `trackerSource()` — already generic over any `{ session_id }` stdin). */
  trackerPath?: string;
  tileSessionsDir?: string;
  legacyMapFile?: string;
  /** HCP control-plane socket + capability token (injected into the agent env). */
  hcpSock?: string;
  hcpToken?: string;
}

export function isKiro(spec: { cmd: string }): boolean {
  // kiro-cli ONLY. `kiro` (bare) is a DIFFERENT product — the Kiro IDE, a VS
  // Code fork (`kiro --help` → "Usage: kiro [options][paths...]"). Nothing in
  // hivemind ever spawns bare `kiro`; matching it here could only misfire a
  // restored `kiro` spec into `kiro chat --resume`, which the IDE reads as
  // "open a folder named chat".
  return basename(spec.cmd.trim().split(/\s+/)[0] ?? "") === "kiro-cli";
}

/** The `hooks` block of the generated `agents/hivemind.json`, in kiro's shape
 *  (an array of `{ command }` / `{ matcher, command }` objects per event — NOT
 *  claude's `{ hooks: [{ type: "command", … }] }` wrapper). Commands carry NO
 *  baked env (the file is shared across kiro tiles) — attribution/supervision
 *  ride the spawn env (HIVEMIND_TILE / HIVE_SUPERVISE), inherited into the hook
 *  subprocess exactly like droid's hooks.json commands rely on. */
export function kiroHooksSettings(deps: KiroResumeDeps): Record<string, unknown[]> {
  const hooks: Record<string, unknown[]> = {};
  if (!deps.execPath || !deps.hcpSock) return hooks;
  const cmd = (hookPath: string) => `ELECTRON_RUN_AS_NODE=1 ${shq(deps.execPath!)} ${shq(hookPath)}`;
  const trackerCmd = deps.trackerPath && deps.tileSessionsDir
    ? `${cmd(deps.trackerPath)} ${shq(deps.tileSessionsDir)}`
    : undefined;
  const spawnAndPrompt: unknown[] = [];
  // Session-id capture — as early as possible (agentSpawn fires at session
  // start). See the module docblock's "session addressing" note.
  if (trackerCmd) spawnAndPrompt.push({ command: trackerCmd });
  if (spawnAndPrompt.length) hooks.agentSpawn = [...spawnAndPrompt];
  const userPrompt: unknown[] = [];
  // Redundant capture point (in case agentSpawn's stdin doesn't carry
  // session_id on some kiro version) + turn START → working (deterministic;
  // pairs with `stop`'s turn END → idle).
  if (trackerCmd) userPrompt.push({ command: trackerCmd });
  if (deps.userpromptHookPath && deps.hcpSock) userPrompt.push({ command: `${cmd(deps.userpromptHookPath)} ${shq(deps.hcpSock)}` });
  if (userPrompt.length) hooks.userPromptSubmit = userPrompt;
  if (deps.stopHookPath && deps.hcpSock) {
    // Turn END → idle + a `turn` event carrying transcript_path (ASSUMPTION,
    // see module docblock) → clean gather when present.
    hooks.stop = [{ command: `${cmd(deps.stopHookPath)} ${shq(deps.hcpSock)}` }];
  }
  if (deps.kiroApprovalHookPath && deps.hcpSock) {
    // Supervise broker (deny-only — see hcp/kiro-approval-hook-source.ts for
    // why "allow" can't be made authoritative without the binary). Matcher "*"
    // — the script itself no-ops unless HIVE_SUPERVISE is set for this spawn.
    hooks.preToolUse = [{ matcher: "*", command: `${cmd(deps.kiroApprovalHookPath)} ${shq(deps.hcpSock)}` }];
  }
  return hooks;
}

/** The full `agents/hivemind.json` custom-agent config: hooks (above) +
 *  `mcpServers.hive` (so the worker can call `hive_report`/`hive_send`/…, same
 *  as claude's `.mcp.json`) so a spawned kiro is a real HCP worker, not just a
 *  hook emitter. `allowedTools` is deliberately left EMPTY — per the skill's
 *  anti-pattern list, hivemind never ships a default-on trust flag; a kiro tile
 *  keeps its own default per-tool prompts, answered by the human on the canvas
 *  (or brokered via `preToolUse` under `supervise`). */
export function kiroAgentConfig(deps: KiroResumeDeps & { hiveCliPath?: string }): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: KIRO_HIVEMIND_AGENT,
    description: "hivemind control-plane wiring (auto-generated — do not edit by hand)",
  };
  if (deps.hiveCliPath) {
    // No HIVE_ROOT: hive-mcp resolves the repo root by walking up from the MCP
    // server subprocess's cwd when unset (packages/hive-mcp/src/index.ts), and
    // that subprocess inherits kiro-cli's own cwd (the tile's project dir) — the
    // same per-project resolution claude/codex get from a project-local
    // `.mcp.json`, without needing one here (this config is a shared, per-
    // install file, not per-project).
    config.mcpServers = { hive: { command: deps.hiveCliPath, args: ["mcp-stdio"], env: { HIVE_AGENT_ID: "kiro" } } };
  }
  const hooks = kiroHooksSettings(deps);
  if (Object.keys(hooks).length) config.hooks = hooks;
  return config;
}

/** Env injected into a spawned kiro: the ephemeral home (so it loads OUR
 *  hivemind.json without touching ~/.kiro) + the HCP socket/token/tile-id (so
 *  its hooks + hive MCP reach the control plane, attributed to this tile) +
 *  HIVE_SUPERVISE passthrough (read by kiroApprovalHookPath at runtime — see
 *  its docblock). */
function kiroEnv(deps: KiroResumeDeps, spec: SpawnSpec, id: string): Record<string, string> | undefined {
  if (!deps.kiroHome && !(deps.hcpSock && deps.hcpToken)) return spec.env;
  const env: Record<string, string> = { ...spec.env };
  if (deps.kiroHome) env.KIRO_HOME = deps.kiroHome;
  if (deps.hcpSock && deps.hcpToken) {
    env.HIVE_HCP_SOCK = deps.hcpSock;
    env.HCP_TOKEN = deps.hcpToken;
    env.HIVEMIND_TILE = id; // hooks + the agent's own hive MCP attribute to this tile
    env.HIVE_AGENT_DEPTH = spec.env?.HIVE_AGENT_DEPTH ?? "0";
  }
  return env; // HIVE_SUPERVISE, if present on spec.env, passes through via the spread above
}

/** Ensure `chat` is present (prepended if missing — bare `kiro-cli` defaults to
 *  it anyway, but being explicit avoids ambiguity with other subcommands) and
 *  APPEND `flags` (e.g. `["--resume", "x"]` or `["--agent", "hivemind"]`) at
 *  the end. Skips a flag group whose KEY (`flags[0]`) is already present
 *  anywhere in `args`, so we never double-inject or clobber a user override. */
function injectAfterChat(args: string[], ...flagGroups: string[][]): string[] {
  const toAdd = flagGroups.filter((g) => g.length > 0 && !args.includes(g[0]!));
  const base = args.includes("chat") ? args : ["chat", ...args];
  if (!toAdd.length) return base;
  return [...base, ...toAdd.flat()];
}

export interface KiroResumeTransforms {
  transformSpecOnSpawn: (spec: SpawnSpec, id: string) => SpawnSpec;
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
}

export function makeKiroResumeTransforms(deps: KiroResumeDeps = {}): KiroResumeTransforms {
  return {
    // Fresh spawn: select our generated custom agent (`--agent hivemind`) so
    // the hooks + mcpServers.hive in the KIRO_HOME overlay take effect, and
    // inject the home + HCP env. No-ops the `--agent` injection if the spec
    // already picks one (user override) or the home wasn't seeded (best-effort
    // seed failure → run kiro with no injected config, scrape-only status).
    transformSpecOnSpawn: (spec, id) => {
      if (!isKiro(spec)) return spec;
      const args = deps.kiroHome ? injectAfterChat(spec.args ?? [], ["--agent", KIRO_HIVEMIND_AGENT]) : (spec.args ?? []);
      return { ...spec, args, env: kiroEnv(deps, spec, id) };
    },
    transformSpecOnRestore: (spec, id) => {
      if (!isKiro(spec)) return spec;
      const withEnv = { ...spec, env: kiroEnv(deps, spec, id) };
      const args0 = withEnv.args ?? [];
      // Already has an explicit resume flag (user override / already restored
      // once this run) — leave the resume args alone, but still make sure the
      // hivemind agent is selected so hooks keep firing.
      if (args0.includes("--resume") || args0.includes("--resume-id")) {
        const args = deps.kiroHome ? injectAfterChat(args0, ["--agent", KIRO_HIVEMIND_AGENT]) : args0;
        return { ...withEnv, args };
      }
      // Prefer the id captured off this tile's own hooks (per-tile, no cwd
      // collision) — falls back to kiro's own newest-session-for-cwd (`--resume`,
      // same cwd-scoped tradeoff pi/droid document) when nothing was captured
      // yet (e.g. daemon restarted before the tile's first hook fired).
      const tracked = deps.tileSessionsDir
        ? readTrackedSession(deps.tileSessionsDir, id, deps.legacyMapFile)
        : undefined;
      const resumeFlag = tracked ? ["--resume-id", tracked] : ["--resume"];
      const agentFlag = deps.kiroHome ? ["--agent", KIRO_HIVEMIND_AGENT] : [];
      const args = injectAfterChat(args0, resumeFlag, agentFlag);
      return { ...withEnv, args };
    },
    // If a restored `--resume`/`--resume-id` dies fast (no matching session),
    // strip it and respawn fresh so a stale/missing session doesn't kill the
    // tile. Keeps `--agent hivemind` so hooks still fire on the fresh session.
    restoreRetryTransform: (spec) => {
      if (!isKiro(spec)) return null;
      const args = spec.args ?? [];
      const ridIdx = args.indexOf("--resume-id");
      if (ridIdx >= 0) return { ...spec, args: [...args.slice(0, ridIdx), ...args.slice(ridIdx + 2)] };
      const rIdx = args.indexOf("--resume");
      if (rIdx >= 0) return { ...spec, args: [...args.slice(0, rIdx), ...args.slice(rIdx + 1)] };
      return null;
    },
  };
}
