#!/usr/bin/env node
/**
 * A scripted stand-in for a coding agent, used by the cross-provider control-plane
 * acceptance test (hcp-cross-provider.spec.ts). No LLM: a "prompt" is a shell
 * snippet it runs with bash, and the snippet's stdout is its "reply".
 *
 * It honours the REAL provider wiring hivemind injects, so the test proves the
 * actual spawn → hooks → turn-tracker → gather path per provider:
 *   - claude: the `--settings <json>` block hivemind prepends (Stop /
 *     UserPromptSubmit hook commands), the positional initial prompt.
 *   - droid:  `$FACTORY_HOME_OVERRIDE/.factory/hooks.json` (top-level event keys),
 *     the initial prompt typed into its stdin once the tile reads idle.
 *   - faux:   `$FAUX_HOOKS` (the throwaway sixth provider's node half), argv prompt.
 *   - codex (or any other name): no hooks — a raw-tier stand-in with no turn signal.
 * Each turn: fire UserPromptSubmit → run the snippet → append the reply to a
 * transcript JSONL (Claude/droid shape) → fire Stop with `transcript_path`.
 * Follow-up prompts arrive as stdin lines (`hive ctl send` types text + Enter).
 * Lines starting with "[hive]" are control-plane deliveries (reports, approvals):
 * echoed, never executed.
 *
 * Invoked through thin shims named `claude` / `droid` on PATH:
 *   exec node fake-agent.cjs claude "$@"
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const [, , provider, ...args] = process.argv;
const tile = process.env.HIVEMIND_TILE || "no-tile";
const sessionId = `fake-${provider}-${process.pid}`;

// ── hook lookup (per provider) ────────────────────────────────────────────────
function hooksTable() {
  if (provider === "claude") {
    const i = args.indexOf("--settings");
    if (i < 0) return {};
    try { return JSON.parse(args[i + 1]).hooks || {}; } catch { return {}; }
  }
  if (provider === "droid") {
    const home = process.env.FACTORY_HOME_OVERRIDE;
    if (!home) return {};
    try { return JSON.parse(fs.readFileSync(path.join(home, ".factory", "hooks.json"), "utf8")); } catch { return {}; }
  }
  if (provider === "faux") {
    // The throwaway sixth provider (zz-sixth-provider.spec.ts): its node half
    // writes a claude-shaped hooks file and points the spawn env at it.
    const file = process.env.FAUX_HOOKS;
    if (!file) return {};
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
  }
  // "codex" and any other name: a raw-tier runtime — no hooks at all. Turns
  // never reach the control plane, which is exactly what the no-turn-signal
  // path under test must surface instead of timing out.
  return {};
}
const HOOKS = hooksTable();
function fire(event, payload) {
  const cmd = HOOKS[event]?.[0]?.hooks?.[0]?.command;
  if (!cmd) return false;
  spawnSync("bash", ["-c", cmd], { input: JSON.stringify(payload), stdio: ["pipe", "ignore", "ignore"], env: process.env, timeout: 10_000 });
  return true;
}

// ── transcript (must live under a root the app trusts: <userData>/droid-home) ─
// The socket path hivemind injects is <userData>/hcp.sock, so the isolated
// profile's droid-home overlay is derivable for BOTH providers — no writes
// outside the test profile.
const userData = path.dirname(process.env.HIVE_HCP_SOCK || path.join(require("node:os").tmpdir(), "x"));
const transcriptDir = path.join(userData, "droid-home", "fake-transcripts");
fs.mkdirSync(transcriptDir, { recursive: true });
const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

// ── the initial prompt ────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(["--settings", "--session-id", "--permission-mode", "--model", "--resume", "-r"]);
function positionalPrompt() {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

// ── one turn ──────────────────────────────────────────────────────────────────
function turn(prompt) {
  process.stdout.write(`\n[${provider}] ▶ ${prompt}\n`);
  fire("UserPromptSubmit", { session_id: sessionId, prompt });
  const r = spawnSync("bash", ["-c", prompt], { encoding: "utf8", env: process.env, timeout: 60_000 });
  const reply = ((r.stdout || "") + (r.status ? `\n[exit ${r.status}] ${r.stderr || ""}` : "")).trim() || "(no output)";
  fs.appendFileSync(
    transcriptPath,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } }) + "\n",
  );
  process.stdout.write(`${reply}\n`);
  fire("Stop", { session_id: sessionId, transcript_path: transcriptPath, stop_hook_active: false });
  process.stdout.write(`${provider}> `);
}

const first = positionalPrompt();
process.stdout.write(`fake ${provider} up (tile ${tile}, hooks: ${Object.keys(HOOKS).join(",") || "none"})\n${provider}> `);
if (first) turn(first);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) { process.stdout.write(`${provider}> `); return; }
  if (text.startsWith("[hive]")) { process.stdout.write(`(delivered) ${text}\n${provider}> `); return; }
  turn(text);
});
rl.on("close", () => process.exit(0));
