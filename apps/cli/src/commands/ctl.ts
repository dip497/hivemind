/**
 * `hive ctl` — drive the RUNNING hivemind desktop app from the shell via the
 * Hivemind Control Plane (HCP): spawn agents on the canvas, send them input,
 * read their replies, list/focus/close tiles, pipe agents together, run
 * workflows, answer approvals, report back to a parent, and open reviews.
 * Plus the issue verbs the old MCP server carried (set-state, add-comment,
 * mark-acceptance, delete-issue, list-workspaces) so an agent needs ONE
 * vocabulary. Create/update/get/list/move/link stay on the top-level `hive`
 * commands (`hive new`, `hive update`, `hive show --json`, `hive list --json`, …).
 *
 * Every subcommand:
 *   • `--json` prints the raw result — the SAME shape the matching MCP tool
 *     returned — as one line on stdout. Without it, a pretty-printed version.
 *   • errors print `{ ok:false, code, message }` (with --json) or a one-line
 *     `error [CODE] message` on stderr, and exit non-zero (see EXIT in hcp.ts:
 *     2 usage · 3 app not running · 4 timeout · 5 not found · 6 unauthorized ·
 *     7 refused · 1 anything else).
 *   • blocking waits are made of SHORT HCP requests (≤ 10 s each) so they
 *     never trip a caller's tool timeout — `read --timeout` is honoured
 *     end-to-end and `--poll` returns immediately.
 */
import { defineCommand, type ArgsDef, type ParsedArgs } from "citty";
import fs from "node:fs";
import {
  HiveError, commentOnIssue, deleteIssue, issueToJson, listWorkspaces, readIssue, requireRoot, rootForId, updateIssue,
  type IssueState,
} from "@hivemind/core";
import { EXIT, HcpCliError, exitCodeFor, hcpCall, hcpStream, ownTile } from "../hcp.js";
import { UnsupportedError, UsageError, boolFlag, intFlag, parseKeys, readSchedule, resolveAgent, workflowParams } from "../ctl-args.js";
import { ensureAgentCatalog } from "../agent-catalog.js";
import { spawnableAgents, workerAgents } from "@hivemind/agents";
import { detectWho } from "../who.js";

const ISSUE_STATES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const;

/** Who signs Activity rows: an agent's id when run inside a spawned tile,
 *  else the human at the keyboard. */
function actor(): string {
  return process.env.HIVE_AGENT_ID || process.env.HIVE_ACTOR || detectWho();
}

function print(result: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
}

function fail(e: unknown, json: boolean): never {
  let code = "INTERNAL", message = String((e as Error)?.message ?? e), exit: number = EXIT.error;
  if (e instanceof HcpCliError) { code = e.code; exit = e.exit; }
  else if (e instanceof UsageError) { code = "USAGE"; exit = EXIT.usage; }
  else if (e instanceof UnsupportedError) { code = "UNSUPPORTED"; exit = EXIT.refused; }
  else if (e instanceof HiveError) {
    code = e.code;
    exit = e.code === "not_found" || e.code === "no_root" ? EXIT.notFound : e.code.includes("invalid") ? EXIT.usage : EXIT.error;
  } else if (/not found|does not exist|ENOENT/i.test(message)) { code = "NOT_FOUND"; exit = EXIT.notFound; }
  else if (/out of range|required|must be/i.test(message)) { code = "BAD_REQUEST"; exit = exitCodeFor(code); }
  if (json) console.log(JSON.stringify({ ok: false, code, message }));
  else process.stderr.write(`error [${code}] ${message}\n`);
  process.exit(exit);
}

const JSON_ARG = { json: { type: "boolean", description: "print the raw result (same shape as the MCP tool) on one line" } } as const;

/** defineCommand with `--json`, structured errors and exit codes wired in. */
function sub<A extends ArgsDef>(
  name: string, description: string, args: A,
  handler: (args: ParsedArgs<A & typeof JSON_ARG>) => Promise<unknown | { __exit: number; result: unknown }>,
) {
  return defineCommand({
    meta: { name, description },
    args: { ...args, ...JSON_ARG },
    async run({ args }) {
      const json = !!args.json;
      try {
        const r = await handler(args as ParsedArgs<A & typeof JSON_ARG>);
        if (r && typeof r === "object" && "__exit" in r) {
          const x = r as { __exit: number; result: unknown };
          print(x.result, json);
          process.exit(x.__exit);
        }
        print(r, json);
      } catch (e) { fail(e, json); }
    },
  });
}

const tileArg = { tileId: { type: "positional", required: true, description: "tile id (from spawn / list)" } } as const;

// ── canvas ───────────────────────────────────────────────────────────────────

const list = sub("list", "List tiles on the canvas grouped by frame (with agent status)",
  { frame: { type: "string", description: "filter to one frame (id, repo name, or title)" } },
  (a) => hcpCall("tile.list", { frame: a.frame }));

const frames = sub("frames", "List canvas frames (id, title, repo, branch, tile count)", {},
  () => hcpCall("tile.list_frames", {}));

const openTool = sub("open-tool", "Open an enabled tool plugin", {
  tool: { type: "positional", required: true, description: "tool id (for example hivemind/web/browser)" },
  frame: { type: "string", description: "target frame id (default: current selection)" },
  url: { type: "string", description: "Browser URL: http, https, or about:blank" },
}, (a) => hcpCall("tool.open", { tool: a.tool, frame: a.frame, url: a.url }));

const spawn = sub("spawn", "Spawn an agent tile; prints { tileId, … }", {
  agent: { type: "string", description: `agent id: ${spawnableAgents().map((d) => d.id).join(" | ")} (default: your default agent, or the first one installed)` },
  prompt: { type: "string", description: "initial task" },
  name: { type: "string", description: "tile title" },
  frame: { type: "string", description: "frame to spawn into (id, repo/worktree name, or title); default: the caller's frame" },
  mode: { type: "string", description: "claude permission mode" },
  model: { type: "string", description: "model override" },
  report: { type: "boolean", description: "worker auto-reports its finished reply to the caller (--no-report to disable)" },
  supervise: { type: "string", description: "broker the worker's tool permissions to this CLI/agent: 'all', or a comma-list of tools" },
}, async (a) => {
  await ensureAgentCatalog(); // --agent may name an agent added from a manifest
  return hcpCall("tile.spawn_agent", {
    agent: resolveAgent(a.agent), prompt: a.prompt, name: a.name, frame: a.frame, mode: a.mode, model: a.model,
    report: boolFlag(a.report), supervise: a.supervise, callerTile: ownTile(),
  });
});

const send = sub("send", "Send text to an agent tile (submits it as a prompt)",
  { ...tileArg, text: { type: "positional", required: true } },
  (a) => hcpCall("agent.send", { tileId: a.tileId, text: a.text }));

const keys = sub("keys", "Send key tokens to a tile's TUI (comma-separated, e.g. Down,Enter)",
  { ...tileArg, keys: { type: "positional", required: true, description: "comma-separated tokens: Down,Enter,Esc,Tab,1,…" } },
  (a) => hcpCall("agent.send_keys", { tileId: a.tileId, keys: parseKeys(String(a.keys)) }));

/** Wire ceiling for one read slice: the slice plus slack for the transcript flush. */
const READ_SLACK_MS = 5_000;
const READ_DEFAULT_MS = 100_000; // under Claude Code's 120 s Bash default

const read = sub("read", "Wait for an agent's turn to finish and print its reply (exit 4 on timeout)", {
  ...tileArg,
  timeout: { type: "string", description: `total wait in ms (default ${READ_DEFAULT_MS}); made of short HCP polls, never one long request` },
  poll: { type: "boolean", description: "don't wait: return the current turn state immediately (always exit 0)" },
}, async (a) => {
  const total = a.poll ? 0 : intFlag(a.timeout, "timeout", READ_DEFAULT_MS);
  let last: unknown = null;
  for (const slice of readSchedule(total)) {
    last = await hcpCall("agent.read", { tileId: a.tileId, timeoutMs: slice }, slice + READ_SLACK_MS);
    if ((last as { finalStatus?: string }).finalStatus === "turn") return last;
  }
  return a.poll ? last : { __exit: EXIT.timeout, result: last };
});

const focus = sub("focus", "Focus a tile", tileArg, (a) => hcpCall("tile.focus", { tileId: a.tileId }));
const close = sub("close", "Close a tile", tileArg, (a) => hcpCall("tile.close", { tileId: a.tileId }));

const connect = sub("connect", "Pipe src agent's replies into dst agent's input",
  { src: { type: "positional", required: true }, dst: { type: "positional", required: true } },
  (a) => hcpCall("tile.connect", { srcTileId: a.src, dstTileId: a.dst }));

const disconnect = sub("disconnect", "Remove pipes from src (optionally only to one dst)",
  { src: { type: "positional", required: true }, dst: { type: "positional" } },
  (a) => hcpCall("tile.disconnect", { srcTileId: a.src, dstTileId: a.dst }));

const workflow = sub("workflow", "Run a multi-agent workflow (fanout | pipeline | mapreduce) of visible worker tiles; blocks until all replies are gathered", {
  shape: { type: "string", default: "fanout", description: "fanout | pipeline | mapreduce" },
  items: { type: "string", description: "fanout/mapreduce: '||'-separated items, one worker each (filled into {item})" },
  prompt: { type: "string", description: "fanout/mapreduce: per-worker task; use {item} placeholder" },
  stages: { type: "string", description: "pipeline: '||'-separated stage prompts; each may use {input}" },
  input: { type: "string", description: "pipeline: seed value for the first stage's {input}" },
  "reduce-prompt": { type: "string", description: "mapreduce: reducer prompt; use {results}" },
  agent: { type: "string", description: `runtime per worker: ${workerAgents().map((d) => d.id).join(" | ")} (default: your default agent, or the first one installed)` },
  model: { type: "string", description: "model override for every worker" },
  frame: { type: "string", description: "frame to spawn workers into (id, repo name, or title)" },
  supervise: { type: "string", description: "broker workers' tool perms to this CLI: 'all' or a comma-list of tools" },
  "max-concurrent": { type: "string", description: "max workers live at once (default 6, cap 12)" },
  timeout: { type: "string", description: "per-worker turn ceiling in ms (default 600000)" },
  close: { type: "boolean", description: "close worker tiles after collecting their replies" },
}, async (a) => {
  await ensureAgentCatalog();
  const { params, ceilingMs } = workflowParams(a, ownTile());
  return hcpCall("workflow.run", params, ceilingMs);
});

const approve = sub("approve", "Answer a supervised worker's approval request", {
  reqId: { type: "positional", required: true },
  decision: { type: "positional", required: true, description: "allow | deny | always | never" },
  reason: { type: "string" },
}, (a) => {
  if (!["allow", "deny", "always", "never"].includes(String(a.decision))) throw new UsageError("decision must be allow | deny | always | never");
  return hcpCall("agent.approve", { reqId: a.reqId, decision: a.decision, reason: a.reason });
});

const report = sub("report", "Deliver a message to the tile that spawned you (the parent agent)", {
  message: { type: "positional", required: true },
  tile: { type: "string", description: "report on behalf of this tile (default: $HIVEMIND_TILE — set inside every spawned agent)" },
}, (a) => {
  const callerTile = a.tile || ownTile();
  if (!callerTile) throw new UsageError("not inside a hivemind agent tile ($HIVEMIND_TILE unset) — pass --tile <tileId>");
  return hcpCall("agent.report", { callerTile, message: a.message });
});

const openReview = sub("open-review", "Open a plan-review tile and block until the human decides", {
  plan: { type: "string", description: "plan markdown (or use --file)" },
  file: { type: "string", description: "read the plan from this file ('-' = stdin)" },
  cwd: { type: "string", description: "repo the plan applies to (default: current directory)" },
  timeout: { type: "string", description: "how long to wait for the decision, ms (default 24h — pass a Bash-tool timeout to match)" },
}, (a) => {
  let plan = a.plan;
  if (!plan && a.file) plan = a.file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(String(a.file), "utf8");
  if (!plan) throw new UsageError("--plan <markdown> or --file <path> required");
  const ceiling = intFlag(a.timeout, "timeout", 24 * 60 * 60 * 1000);
  return hcpCall("review.open", { plan, cwd: a.cwd || process.cwd() }, ceiling);
});

// ── stream ───────────────────────────────────────────────────────────────────

const stream = defineCommand({
  meta: { name: "stream", description: "Stream a tile's live terminal output to stdout (ANSI-stripped). --lines/--since replay the recorded tail first" },
  args: {
    ...tileArg,
    since: { type: "string", description: "replay from this byte offset (as printed by a previous --json run) before going live" },
    lines: { type: "string", description: "replay the last N recorded lines before going live" },
    timeout: { type: "string", description: "stop after this many ms (default 0 = until Ctrl-C)" },
    snapshot: { type: "boolean", description: "print the replay and exit (no live tail)" },
    json: { type: "boolean", description: "NDJSON: one {seq,chunk,offset,replay} per event, then {end:true,offset}" },
  },
  async run({ args }) {
    const json = !!args.json;
    try {
      const since = args.since != null ? intFlag(args.since, "since", 0) : undefined;
      const lines = args.lines != null ? intFlag(args.lines, "lines", 0) : undefined;
      let timeoutMs = intFlag(args.timeout, "timeout", 0);
      if (args.snapshot && !timeoutMs) timeoutMs = 400; // long enough for the replay event to land
      const signal = { stop: () => {} };
      process.on("SIGINT", () => signal.stop());
      const { offset } = await hcpStream({ tileId: String(args.tileId), since, lines }, (ev) => {
        if (json) console.log(JSON.stringify(ev));
        else process.stdout.write(ev.chunk ?? "");
        if (args.snapshot && ev.replay) signal.stop();
      }, { timeoutMs: timeoutMs || undefined, signal });
      if (json) console.log(JSON.stringify({ end: true, offset }));
      process.exit(0);
    } catch (e) { fail(e, json); }
  },
});

// ── issues (same shapes as the retired MCP tools) ────────────────────────────

const setState = sub("set-state", "Set an issue's state (optionally with a note); prints the issue", {
  id: { type: "positional", required: true },
  state: { type: "positional", required: true, description: ISSUE_STATES.join(" | ") },
  note: { type: "string", description: "activity comment explaining the change" },
}, async (a) => {
  const state = String(a.state) as IssueState;
  if (!ISSUE_STATES.includes(state)) throw new UsageError(`state must be one of ${ISSUE_STATES.join(", ")}`);
  const r = await rootForId(await requireRoot(), String(a.id));
  await updateIssue(r, String(a.id), { state }, actor());
  if (a.note) await commentOnIssue(r, String(a.id), String(a.note), actor());
  return issueToJson(await readIssue(r, String(a.id)));
});

const addComment = sub("add-comment", "Append an activity comment to an issue", {
  id: { type: "positional", required: true },
  message: { type: "positional", required: true },
}, async (a) => {
  const r = await rootForId(await requireRoot(), String(a.id));
  await commentOnIssue(r, String(a.id), String(a.message), actor());
  const after = await readIssue(r, String(a.id));
  return { ok: true, activity: after.sections.activity.slice(-3) };
});

const markAcceptance = sub("mark-acceptance", "Tick (or untick) an acceptance criterion by 0-based index", {
  id: { type: "positional", required: true },
  index: { type: "positional", required: true, description: "0-based, in `hive show --json` order" },
  undone: { type: "boolean", description: "reopen the criterion instead of marking it done" },
}, async (a) => {
  const index = intFlag(a.index, "index", -1);
  const r = await rootForId(await requireRoot(), String(a.id));
  const cur = await readIssue(r, String(a.id));
  const ac = [...cur.sections.acceptanceCriteria];
  if (index < 0 || index >= ac.length) throw new UsageError(`acceptance index ${index} out of range (have ${ac.length} criteria)`);
  const done = !a.undone;
  ac[index] = { ...ac[index]!, done };
  await updateIssue(r, String(a.id), { acceptanceCriteria: ac }, actor());
  await commentOnIssue(r, String(a.id), `acceptance[${index}] ${done ? "done" : "reopened"}: ${ac[index]!.text}`, actor());
  return { ok: true, criterion: ac[index] };
});

const deleteIssueCmd = sub("delete-issue", "Delete an issue file (irreversible)", {
  id: { type: "positional", required: true },
}, async (a) => {
  const r = await rootForId(await requireRoot(), String(a.id));
  await deleteIssue(r, String(a.id));
  return { ok: true, deleted: String(a.id) };
});

const listWorkspacesCmd = sub("list-workspaces", "List every registered workspace (prefix, title, repo)", {},
  async () => (await listWorkspaces({ persistPrune: true })).map((w) => ({ prefix: w.prefix, title: w.title, repo: w.repo })));

export const ctlCmd = defineCommand({
  meta: { name: "ctl", description: "Drive the running hivemind app (spawn/send/read/stream/workflow/report) and the issue verbs agents use" },
  subCommands: {
    list, frames, "open-tool": openTool, spawn, send, keys, read, stream, workflow, approve, report, "open-review": openReview,
    focus, close, connect, disconnect,
    "set-state": setState, "add-comment": addComment, "mark-acceptance": markAcceptance,
    "delete-issue": deleteIssueCmd, "list-workspaces": listWorkspacesCmd,
  },
});
