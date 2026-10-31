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
 * With FAKE_STEER set, a turn runs while it reads, and a line typed during it is taken into that
 * turn, as claude takes one: recorded as claude 2.1.3xx records it (a queue-operation enqueue as it
 * is typed; once the snippet is done, a remove "absorbed_mid_turn" and a queued_command attachment),
 * and its reply says it heard it.
 *
 * With FAKE_PHOTO_MARKS set, a prompt's photo paths are attached as claude attaches them: recorded
 * as a mark each, "[Image #1]", before the words, and the photo itself.
 *
 * Invoked through thin shims named `claude` / `droid` on PATH:
 *   exec node fake-agent.cjs claude "$@"
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const [, , provider, ...args] = process.argv;
// What it shows at its prompt: FAKE_PROMPT, as claude's own (`❯ `) for its screen to read idle there.
const PROMPT = process.env.FAKE_PROMPT || `${provider}> `;
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
/** A prompt as recorded: with FAKE_PHOTO_MARKS, its photo paths are marks and photos. */
let photos = 0;
function asSaid(prompt) {
  const paths = prompt.match(/\/\S+\.(?:png|jpe?g|webp|gif)\b/g) || [];
  if (!process.env.FAKE_PHOTO_MARKS || !paths.length) return prompt;
  const words = paths.reduce((t, p) => t.replace(p, ""), prompt).trim();
  const marks = paths.map(() => `[Image #${++photos}]`).join("");
  return [{ type: "text", text: marks + words }, ...paths.map(() => ({ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }))];
}
/** A record of claude's own kind, as it is: `queue-operation`, `attachment`. */
const recordAs = (fields) => fs.appendFileSync(transcriptPath, JSON.stringify({ ...fields, timestamp: new Date().toISOString(), sessionId }) + "\n");

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
    process.stdout.write(PROMPT);
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
  if (process.env.FAKE_STEER) return steerable(prompt);
  const r = spawnSync("bash", ["-c", prompt], { encoding: "utf8", env: process.env, timeout: 60_000 });
  const text = ((r.stdout || "") + (r.status ? `\n[exit ${r.status}] ${r.stderr || ""}` : "")).trim() || "(no output)";
  record("user", asSaid(prompt));
  reply(text);
}

/** Lines typed during the turn running now; null when none runs. */
let absorbing = null;
/** A turn that reads while it runs: what is typed meanwhile is taken in at its next step. */
function steerable(prompt) {
  record("user", asSaid(prompt));
  absorbing = [];
  const child = spawn("bash", ["-c", prompt], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.on("close", (status) => {
    const heard = absorbing;
    absorbing = null;
    for (const line of heard) {
      const id = `${sessionId}-${++said}`;
      recordAs({ type: "queue-operation", operation: "remove", content: line, reason: "absorbed_mid_turn", commandUuid: id, deliveryId: id });
      recordAs({ parentUuid: null, isSidechain: false, type: "attachment", uuid: id, cwd: process.cwd(), userType: "external",
        attachment: { type: "queued_command", prompt: line, source_uuid: id, delivery_id: id, commandMode: "prompt", origin: { kind: "human" }, timestamp: new Date().toISOString(), humanTurn: true } });
    }
    const text = (out.trim() || "(no output)") + (status ? ` [exit ${status}]` : "") + heard.map((l) => `\nheard while working: ${l}`).join("");
    reply(text);
  });
}

/** What it says is running in the background as a turn ends: `.fake-background.json`, in its folder. */
function backgroundTasks() {
  try { return { background_tasks: JSON.parse(fs.readFileSync(".fake-background.json", "utf8")) }; } catch { return {}; }
}

function reply(text) {
  record("assistant", [{ type: "text", text }]);
  process.stdout.write(`${text}\n`);
  fire("Stop", { session_id: sessionId, transcript_path: transcriptPath, stop_hook_active: false, last_assistant_message: text, ...backgroundTasks() });
  process.stdout.write(PROMPT);
}

const first = positionalPrompt();
let gated = !!process.env.FAKE_GATE;
if (gated) process.stdout.write(`${process.env.FAKE_GATE}\n`);
else process.stdout.write(`fake ${provider} up (tile ${tile}, hooks: ${Object.keys(HOOKS).join(",") || "none"})\n${PROMPT}`);
if (first) turn(first);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (gated) {
    // Past the startup screen: it is gone, and the prompt is up.
    gated = false;
    process.stdout.write(`\x1b[2J\x1b[Hfake ${provider} up (tile ${tile}, hooks: ${Object.keys(HOOKS).join(",") || "none"})\n${PROMPT}`);
    return;
  }
  const text = line.trim();
  if (!text) { process.stdout.write(PROMPT); return; }
  // A delivery is a prompt like any other, a turn with its hooks, as claude takes it: the
  // control plane holds the next delivery until that turn ends.
  if (text.startsWith("[hive]")) {
    fire("UserPromptSubmit", { session_id: sessionId, prompt: text });
    process.stdout.write(`(delivered) ${text}\n`);
    fire("Stop", { session_id: sessionId, transcript_path: transcriptPath, stop_hook_active: false, last_assistant_message: "(delivered)" });
    process.stdout.write(PROMPT);
    return;
  }
  if (picker) { const answer = picker; picker = null; answer(text); return; }
  if (absorbing) {
    absorbing.push(text);
    recordAs({ type: "queue-operation", operation: "enqueue", content: text });
    process.stdout.write(`queued: ${text}\n`);
    return;
  }
  turn(text);
});
rl.on("close", () => process.exit(0));
