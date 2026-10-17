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
 *   - cursor-agent (or any other name): no hooks — a raw-tier stand-in with no turn signal.
 * Each turn: fire UserPromptSubmit → run the snippet → append the reply to a
 * transcript JSONL (Claude/droid shape) → fire Stop with `transcript_path` and, as
 * claude does, `last_assistant_message`.
 * Follow-up prompts arrive as stdin lines (`hive ctl send` types text + Enter).
 * Lines starting with "[hive]" are control-plane deliveries (reports, approvals):
 * a turn that echoes them, never executes them.
 * With FAKE_GATE set it first shows that text, as an agent shows a startup screen
 * before it takes anything, and the first line it reads only clears it.
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
// The session hivemind binds (`--session-id`), as claude takes it; else one of its own.
const bound = args.includes("--session-id") ? args[args.indexOf("--session-id") + 1] : "";
const sessionId = bound || `fake-${provider}-${process.pid}`;
// The session a restore or a `--resume` asked for, for a turn to echo back.
process.env.FAKE_RESUMED = args.includes("--resume") ? args[args.indexOf("--resume") + 1] || "" : "";

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
  // "cursor-agent" and any other name: a raw-tier runtime — no hooks at all. Turns
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
/** Ask the hook for `event` whose matcher takes `name`, as claude picks one, and give back what it
 *  printed: how a PreToolUse hook answers. */
function ask(event, name, payload) {
  const entry = (HOOKS[event] || []).find((e) => !e.matcher || e.matcher === "*" || new RegExp(`^(?:${e.matcher})$`).test(name));
  const cmd = entry?.hooks?.[0]?.command;
  if (!cmd) return `(no hook: ${Object.keys(HOOKS).join(",")})`;
  const r = spawnSync("bash", ["-c", cmd], { input: JSON.stringify(payload), encoding: "utf8", env: process.env, timeout: 600_000 });
  return (r.stdout || "").trim() || "(nothing)";
}

// ── transcript: claude's where claude keeps it, under $HOME/.claude/projects/<its folder>; any
// other's inside the isolated test profile, derived from the socket path hivemind injects
// (<userData>/hcp.sock), where droid's plugin reads its reply.
const userData = path.dirname(process.env.HIVE_HCP_SOCK || path.join(require("node:os").tmpdir(), "x"));
const transcriptDir = provider === "claude"
  ? path.join(require("node:os").homedir(), ".claude", "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"))
  : path.join(userData, "droid-home", "fake-transcripts");
fs.mkdirSync(transcriptDir, { recursive: true });
const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
let said = 0;
/** One record of the transcript, in claude's shape. */
const record = (type, content) => fs.appendFileSync(transcriptPath, JSON.stringify({
  type, uuid: `${sessionId}-${++said}`, timestamp: new Date().toISOString(), cwd: process.cwd(), message: { role: type, content },
}) + "\n");

// ── the initial prompt ────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(["--settings", "--session-id", "--permission-mode", "--model", "--resume", "-r", "--auto"]);
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
// A prompt "ASK:<question>" stops at a picker, as claude's AskUserQuestion does: the
// PermissionRequest hook fires and the next stdin line is the answer.
let picker = null;
function turn(prompt) {
  // `TOOL <name> <input json>`: a tool use, asked of its PreToolUse hook as claude asks it; what the
  // hook answers is the reply, and is written to $FAKE_TOOL_LOG.
  const tool = /^TOOL (\S+) (.*)$/.exec(prompt);
  if (tool) {
    fire("UserPromptSubmit", { session_id: sessionId, prompt });
    const answer = ask("PreToolUse", tool[1], { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: tool[1], tool_input: JSON.parse(tool[2]) });
    if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, `${tool[1]} ${answer}\n`);
    process.stdout.write(`${answer}\n`);
    fire("Stop", { session_id: sessionId, transcript_path: transcriptPath, stop_hook_active: false, last_assistant_message: answer });
    process.stdout.write(`${provider}> `);
    return;
  }
  process.stdout.write(`\n[${provider}] ▶ ${prompt}\n`);
  // Like claude: the window title says what the turn is doing, behind a status glyph.
  process.stdout.write(`\x1b]0;✳ ${prompt}\x07`);
  fire("UserPromptSubmit", { session_id: sessionId, prompt });
  if (prompt.startsWith("ASK:")) {
    process.stdout.write(`${prompt.slice(4)}\n ❯ 1. yes\n   2. no\n Enter to select\n`);
    picker = (answer) => {
      fire("PostToolUse", { session_id: sessionId, tool_name: "AskUserQuestion" });
      reply(`answered: ${answer}`);
    };
    fire("PermissionRequest", { session_id: sessionId, tool_name: "AskUserQuestion", tool_input: { questions: [{ question: prompt.slice(4) }] } });
    return;
  }
  const r = spawnSync("bash", ["-c", prompt], { encoding: "utf8", env: process.env, timeout: 60_000 });
  const text = ((r.stdout || "") + (r.status ? `\n[exit ${r.status}] ${r.stderr || ""}` : "")).trim() || "(no output)";
  record("user", prompt);
  reply(text);
}

function reply(text) {
  record("assistant", [{ type: "text", text }]);
  process.stdout.write(`${text}\n`);
  fire("Stop", { session_id: sessionId, transcript_path: transcriptPath, stop_hook_active: false, last_assistant_message: text });
  process.stdout.write(`${provider}> `);
}

const first = positionalPrompt();
let gated = !!process.env.FAKE_GATE;
if (gated) process.stdout.write(`${process.env.FAKE_GATE}\n`);
else process.stdout.write(`fake ${provider} up (tile ${tile}, hooks: ${Object.keys(HOOKS).join(",") || "none"})\n${provider}> `);
if (first) turn(first);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (gated) {
    // Past the startup screen: it is gone, and the prompt is up.
    gated = false;
    process.stdout.write(`\x1b[2J\x1b[Hfake ${provider} up (tile ${tile}, hooks: ${Object.keys(HOOKS).join(",") || "none"})\n${provider}> `);
    return;
  }
  const text = line.trim();
  if (!text) { process.stdout.write(`${provider}> `); return; }
  // A delivery is a prompt like any other, a turn with its hooks, as claude takes it: the
  // control plane holds the next delivery until that turn ends.
  if (text.startsWith("[hive]")) {
    fire("UserPromptSubmit", { session_id: sessionId, prompt: text });
    process.stdout.write(`(delivered) ${text}\n`);
    fire("Stop", { session_id: sessionId, transcript_path: transcriptPath, stop_hook_active: false, last_assistant_message: "(delivered)" });
    process.stdout.write(`${provider}> `);
    return;
  }
  if (picker) { const answer = picker; picker = null; answer(text); return; }
  turn(text);
});
rl.on("close", () => process.exit(0));
