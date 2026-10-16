/**
 * `hive ctl` — drive the RUNNING hivemind app or `hive host` from the shell, on its drive socket
 * (the workspace API, as the agent whose tile this runs in or the person): spawn agents, send them input,
 * read their replies, list/focus/close tiles, pipe agents together, run
 * workflows, answer approvals, report back to a parent, and open reviews.
 * Plus the issue verbs the old MCP server carried (set-state, add-comment,
 * mark-acceptance, delete-issue, list-workspaces) so an agent needs ONE
 * vocabulary. Create/update/get/list/move/link stay on the top-level `hive`
 * commands (`hive new`, `hive update`, `hive show --json`, `hive list --json`, …).
 *
 * Every subcommand:
 *   • `--json` prints the result as the workspace API answers it, as one line
 *     on stdout. Without it, a pretty-printed version.
 *   • errors print `{ ok:false, code, message }` (with --json) or a one-line
 *     `error [CODE] message` on stderr, and exit non-zero (see EXIT in hcp.ts:
 *     2 usage · 3 app not running · 4 timeout · 5 not found · 6 unauthorized ·
 *     7 refused · 1 anything else).
 *   • blocking waits are made of short requests (≤ 10 s each) so they
 *     never trip a caller's tool timeout — `read --timeout` is honoured
 *     end-to-end and `--poll` returns immediately. A plugin's command is one
 *     request: 30 s in the window, the host and this CLI each waiting longer
 *     than the hop within, so the reason printed is the innermost one.
 */
import path from "node:path";
import { defineCommand, type ArgsDef, type ParsedArgs } from "citty";
import fs from "node:fs";
import {
  HiveError, commentOnIssue, deleteIssue, issueToJson, listWorkspaces, readIssue, requireRoot, rootForId, updateIssue,
  type IssueState,
} from "@hivemind/core";
import { EXIT, HcpCliError, exitCodeFor, hcpCall, ownTile } from "../hcp.js";
import { stripAnsi } from "@hivemind/host/control/output-recorder";
import { openDrive, type Drive } from "../drive.js";
import { UnsupportedError, UsageError, boolFlag, emitArgs, durationFlag, intFlag, parseKeys, resolveAgent, superviseOf, workflowPlan } from "../ctl-args.js";
import { readTurn, runWorkflow } from "../workflow.js";
import { ensureAgentCatalog } from "../agent-catalog.js";
import { detectWho } from "../who.js";
import type { InboxMessage } from "@hivemind/workspace-api/agents";
import { PLUGIN_CALL_CLIENT_MS, type PluginInstance, type PluginList } from "@hivemind/workspace-api/plugins";

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
  let code = "FAILED", message = String((e as Error)?.message ?? e), exit: number = EXIT.error;
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

const JSON_ARG = { json: { type: "boolean", description: "print the result as JSON on one line" } } as const;

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

/** Run `use` on the drive socket, as whoever this is. */
async function onDrive<T>(use: (d: Drive) => Promise<T>): Promise<T> {
  const d = await openDrive();
  try {
    return await use(d);
  } finally {
    d.close();
  }
}

/** The workspace a command acts on: `--repo`, else an agent's own, else of those open here the one
 *  this folder is in, or the only one. */
async function workspaceOf(d: Drive, repo: unknown): Promise<string> {
  if (typeof repo === "string" && repo) return path.resolve(repo);
  if (d.as !== "person") return d.as.workspace;
  const open = ((await d.call("host.status", [])) as { workspaces: Array<{ repo: string }> }).workspaces.map((w) => w.repo);
  const here = process.cwd();
  const within = open.filter((r) => here === r || here.startsWith(r + path.sep)).sort((a, b) => b.length - a.length);
  if (within.length) return within[0]!;
  if (open.length === 1) return open[0]!;
  throw new UsageError(open.length ? `which workspace? run this inside one, or give --repo: ${open.join(", ")}` : "no workspace is open: open one in the app, or `hive host add <folder>`");
}

const repoArg = { repo: { type: "string", description: "the workspace's folder (default: your own, as an agent; else the one this folder is in)" } } as const;

type FeedAgent = { tile: string; agent: string; state: string; waiting?: { kind: string } };
type FeedEvent = { seq: number; kind: string; tile: string; detail?: string };

/** One agent as a line: its tile, name, state, and what it waits on. */
const agentLine = (a: FeedAgent): string => `${a.tile}\t${a.agent}\t${a.state}${a.waiting ? `\twaiting: ${a.waiting.kind}` : ""}`;

// The workspace's agents, as the app's agent feed says; --watch follows what happens to them.
const agents = defineCommand({
  meta: { name: "agents", description: "The workspace's agents and what each waits on; --watch follows what happens to them" },
  args: {
    ...repoArg,
    watch: { type: "boolean", description: "keep going: print each turn ended, wait and answer as it happens (one JSON per line with --json)" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const json = !!args.json;
    try {
      const d = await openDrive();
      const repo = await workspaceOf(d, args.repo);
      // Heard from before the list, so nothing that happens meanwhile is missed.
      const heard: FeedEvent[] = [];
      let show = (e: FeedEvent) => { heard.push(e); };
      d.on("agent.event", (at, e) => { if (at === repo) show(e as FeedEvent); });
      let listed = await d.call("agent.list", [repo]) as { seq: number; agents: FeedAgent[] };
      if (!args.watch) {
        d.close();
        if (json) return console.log(JSON.stringify(listed));
        console.log(listed.agents.map(agentLine).join("\n") || "no agents");
        return;
      }
      if (!json) for (const a of listed.agents) console.log(agentLine(a));
      let seq = listed.seq;
      show = (e) => {
        if (e.seq <= seq) return;
        seq = e.seq;
        console.log(json ? JSON.stringify(e) : `${e.tile}\t${e.kind}${e.detail ? `\t${e.detail}` : ""}`);
      };
      for (const e of heard) show(e);
      await d.closed;
      throw new HcpCliError("UNAVAILABLE", "the app or host stopped", EXIT.unavailable);
    } catch (e) { fail(e, json); }
  },
});

const frames = sub("frames", "The workspace's frames, where an agent may be started (id, name, machine)", repoArg,
  (a) => onDrive(async (d) => ((await d.call("agent.startable", [await workspaceOf(d, a.repo)])) as { frames: unknown[] }).frames));

/** `--frame`: a frame of the workspace by its id, or by its name in any case, as `frames` lists them. */
async function frameIn(d: Drive, repo: string, given: string): Promise<string> {
  const { frames } = await d.call("agent.startable", [repo]) as { frames: Array<{ id: string; name: string }> };
  const frame = frames.find((f) => f.id === given) ?? frames.find((f) => f.name.toLowerCase() === given.toLowerCase());
  if (!frame) throw new HcpCliError("NOT_FOUND", `no frame ${given} in this workspace: \`hive ctl frames\` lists them`, EXIT.notFound);
  return frame.id;
}

const openTool = sub("open-tool", "Open an enabled tool plugin", {
  tool: { type: "positional", required: true, description: "tool id (for example hivemind/web/browser)" },
  frame: { type: "string", description: "target frame (id, repo name, or title; default: beside the calling agent, else the one selected); exit 5 when none answers to it" },
  url: { type: "string", description: "Browser URL: http, https, or about:blank" },
  ...repoArg,
}, (a) => onDrive(async (d) => d.call("tool.open", [await workspaceOf(d, a.repo), { tool: a.tool, ...(a.frame ? { frame: a.frame } : {}), ...(a.url ? { url: a.url } : {}) }])));

const spawn = sub("spawn", "Spawn an agent tile; prints { tile }", {
  // Named, not listed: help is built before the agents on this machine are loaded, so a
  // list here would silently omit every agent you installed. An `--agent` that is wrong is
  // answered with the real list, which is the moment it matters.
  agent: { type: "string", description: "agent id — `hive agents list` (default: your default agent, or the first one installed)" },
  prompt: { type: "string", description: "initial task" },
  name: { type: "string", description: "tile title" },
  frame: { type: "string", description: "frame to spawn into, by its id or name (`hive ctl frames`); default: the caller's frame, else the one selected; exit 5 when none answers to it" },
  mode: { type: "string", description: "permission mode; yolo = ask nothing" },
  model: { type: "string", description: "model override" },
  report: { type: "boolean", description: "worker auto-reports its finished reply to the caller (--no-report to disable)" },
  supervise: { type: "string", description: "broker the worker's tool permissions to this CLI/agent: 'all', or a comma-list of tools" },
  resume: { type: "string", description: "continue this session instead of starting one — ids from `hive ctl sessions <agent>`" },
  ...repoArg,
}, async (a) => {
  await ensureAgentCatalog(); // --agent may name an agent added from a manifest
  const program = resolveAgent(a.agent);
  const report = boolFlag(a.report);
  const given = { prompt: a.prompt, name: a.name, mode: a.mode, model: a.model, resume: a.resume };
  return onDrive(async (d) => {
    const repo = await workspaceOf(d, a.repo);
    return d.call("agent.start", [repo, {
      program,
      ...Object.fromEntries(Object.entries(given).filter(([, v]) => typeof v === "string" && v)),
      ...(a.frame ? { frame: await frameIn(d, repo, String(a.frame)) } : {}),
      ...(report !== undefined ? { report } : {}),
      ...(a.supervise ? { supervise: superviseOf(String(a.supervise)) } : {}),
    }]);
  });
});

const sessions = sub("sessions", "An agent's past sessions in a folder, newest first, to resume with `hive ctl spawn --resume <id>`", {
  agent: { type: "positional", required: false, description: "agent id (default: your default agent)" },
  cwd: { type: "string", description: "the folder they were started in (default: the current one)" },
  limit: { type: "string", description: "at most this many (default 100)" },
}, async (a) => {
  await ensureAgentCatalog();
  const program = resolveAgent(a.agent as string | undefined);
  const limit = intFlag(a.limit, "limit", 100);
  return onDrive((d) => d.call("agent.sessions", [path.resolve(a.cwd ?? process.cwd()), program, limit]));
});

const notFound = (tile: unknown) => new HcpCliError("NOT_FOUND", `no agent runs in tile ${String(tile)}`, EXIT.notFound);

const send = sub("send", "Send text to an agent tile (submits it as a prompt; held until its turn ends, or --interrupt it first)",
  {
    ...tileArg, text: { type: "positional", required: true },
    interrupt: { type: "boolean", description: "stop the turn it is in first, with the keys its agent says interrupt it, so this is read now" },
  },
  (a) => onDrive(async (d) => {
    if (a.interrupt) await d.call("agent.interrupt", [a.tileId]);
    const r = await d.call("agent.send", [a.tileId, a.text]) as { sent: boolean };
    if (!r.sent) throw notFound(a.tileId);
    return r;
  }));

const keys = sub("keys", "Send key tokens to a tile's TUI (comma-separated, e.g. Down,Enter)",
  { ...tileArg, keys: { type: "positional", required: true, description: "comma-separated tokens: Down,Enter,Esc,Tab,1,…" } },
  (a) => {
    const keys = parseKeys(String(a.keys));
    return onDrive((d) => d.call("agent.keys", [a.tileId, keys]));
  });

const READ_DEFAULT_MS = 100_000; // under Claude Code's 120 s Bash default

const read = sub("read", "Wait for an agent's turn to finish and print its reply (exit 4 on timeout, 5 if it closes, 8 if it stops to wait on an answer)", {
  ...tileArg,
  timeout: { type: "string", description: `total wait, e.g. 90s or 5m (default ${READ_DEFAULT_MS / 1000}s); made of short HCP polls, never one long request` },
  poll: { type: "boolean", description: "don't wait: return the current turn state immediately (always exit 0)" },
}, async (a) => {
  const total = a.poll ? 0 : durationFlag(a.timeout, "timeout", READ_DEFAULT_MS);
  return onDrive(async (d) => {
    const r = await readTurn(d, String(a.tileId), total);
    if (r.finalStatus === "turn" || a.poll) return r;
    // Closed while we waited: no turn is coming. Waiting: none comes until it is answered.
    return { __exit: r.finalStatus === "closed" ? EXIT.notFound : r.finalStatus === "waiting" ? EXIT.waiting : EXIT.timeout, result: r };
  });
});

const focus = sub("focus", "Bring a tile forward in the window", tileArg, (a) => onDrive((d) => d.call("tile.focus", [a.tileId])));
const close = sub("close", "Close an agent: its session ends and its tile goes", tileArg, (a) => onDrive(async (d) => {
  const r = await d.call("agent.close", [a.tileId]) as { closed: boolean };
  if (!r.closed) throw notFound(a.tileId);
  return r;
}));
const rename = sub("rename", "Name an agent; with no name, take its name away",
  { ...tileArg, name: { type: "positional", required: false, description: "the name every surface shows it by" } },
  (a) => onDrive((d) => d.call("agent.rename", [a.tileId, a.name ?? ""])));

const connect = sub("connect", "Pipe src agent's replies into dst agent's input",
  { src: { type: "positional", required: true }, dst: { type: "positional", required: true } },
  (a) => onDrive((d) => d.call("link.connect", [a.src, a.dst])));

const disconnect = sub("disconnect", "Remove pipes from src (optionally only to one dst)",
  { src: { type: "positional", required: true }, dst: { type: "positional", required: false } },
  (a) => onDrive((d) => d.call("link.disconnect", a.dst ? [a.src, a.dst] : [a.src])));

const workflow = sub("workflow", "Run a multi-agent workflow (fanout | pipeline | mapreduce) of visible worker tiles; blocks until all replies are gathered", {
  shape: { type: "string", default: "fanout", description: "fanout | pipeline | mapreduce" },
  items: { type: "string", description: "fanout/mapreduce: '||'-separated items, one worker each (filled into {item})" },
  prompt: { type: "string", description: "fanout/mapreduce: per-worker task; use {item} placeholder" },
  stages: { type: "string", description: "pipeline: '||'-separated stage prompts; each may use {input}" },
  input: { type: "string", description: "pipeline: seed value for the first stage's {input}" },
  "reduce-prompt": { type: "string", description: "mapreduce: reducer prompt; use {results}" },
  agent: { type: "string", description: "runtime per worker: an agent that reports back — `hive agents list` (default: your default agent, or the first one installed)" },
  model: { type: "string", description: "model override for every worker" },
  frame: { type: "string", description: "frame to spawn workers into, by its id or name (`hive ctl frames`)" },
  supervise: { type: "string", description: "broker workers' tool perms to this CLI: 'all' or a comma-list of tools" },
  "max-concurrent": { type: "string", description: "max workers live at once (default 6, cap 12)" },
  timeout: { type: "string", description: "per-worker turn ceiling, e.g. 10m (default 10m)" },
  close: { type: "boolean", description: "close worker tiles after collecting their replies" },
  ...repoArg,
}, async (a) => {
  await ensureAgentCatalog();
  const plan = workflowPlan(a);
  return onDrive(async (d) => {
    const repo = await workspaceOf(d, a.repo);
    return runWorkflow(d, repo, plan.frame ? { ...plan, frame: await frameIn(d, repo, plan.frame) } : plan);
  });
});

type Waiting = { tile: string; waiting?: { since: number; approval?: { request: string } } };

const approve = sub("approve", "Answer a supervised worker's approval request; always / never decide that tool for that worker from now on", {
  reqId: { type: "positional", required: true },
  decision: { type: "positional", required: true, description: "allow | deny | always | never" },
  reason: { type: "string" },
  ...repoArg,
}, (a) => {
  const decision = String(a.decision);
  if (!["allow", "deny", "always", "never"].includes(decision)) throw new UsageError("decision must be allow | deny | always | never");
  const answer = {
    decision: decision === "allow" || decision === "always" ? "allow" : "deny",
    ...(a.reason ? { feedback: String(a.reason) } : {}),
    ...(decision === "always" || decision === "never" ? { always: true } : {}),
  };
  return onDrive(async (d) => {
    const { agents } = await d.call("agent.list", [await workspaceOf(d, a.repo)]) as { agents: Waiting[] };
    const asking = agents.find((w) => w.waiting?.approval?.request === a.reqId);
    const gone = () => new HcpCliError("BAD_REQUEST", `no approval ${String(a.reqId)} is waiting: it was answered, ran out of time, or its worker stopped waiting`, EXIT.usage);
    if (!asking) throw gone();
    const r = await d.call("agent.answer", [asking.tile, asking.waiting!.since, answer]) as { answered: boolean };
    if (!r.answered) throw gone();
    return r;
  });
});

const report = sub("report", "Deliver a message to the tile that spawned you (the parent agent)", {
  message: { type: "positional", required: true },
  tile: { type: "string", description: "report on behalf of this tile, from a terminal (default: $HIVEMIND_TILE — set inside every spawned agent, which reports only as itself)" },
}, (a) => {
  const callerTile = a.tile || ownTile();
  if (!callerTile) throw new UsageError("not inside a hivemind agent tile ($HIVEMIND_TILE unset) — pass --tile <tileId>");
  return hcpCall("agent.report", { callerTile, message: a.message });
});

type Inboxed = { messages: InboxMessage[]; dropped: number };

/** What another agent sent, as a block a reader can tell apart from the rest. */
const inboxBlock = (m: InboxMessage): string =>
  `── #${m.id} ${m.kind} from ${m.name}${m.turn !== undefined ? `, turn ${m.turn}` : ""} ──\n${m.text}`;

const inbox = defineCommand({
  meta: { name: "inbox", description: "What your agents sent you (replies, reports, waits, approvals), oldest first; each is read once" },
  args: {
    wait: { type: "string", description: "when none has come, wait this long for the first, e.g. 90s or 5m (at most 10m)" },
    tile: { type: "string", description: "whose inbox, from a terminal (default: $HIVEMIND_TILE — set inside every spawned agent)" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const json = !!args.json;
    try {
      const callerTile = args.tile || ownTile();
      if (!callerTile) throw new UsageError("not inside a hivemind agent tile ($HIVEMIND_TILE unset) — pass --tile <tileId>");
      const wait = durationFlag(args.wait, "wait", 0);
      const r = await hcpCall("agent.inbox", { callerTile, wait }, wait + 30_000) as Inboxed;
      if (json) return console.log(JSON.stringify(r));
      const lines = r.messages.map(inboxBlock);
      if (r.dropped) lines.unshift(`(${r.dropped} older messages were dropped unread)`);
      console.log(lines.join("\n\n") || "no messages");
    } catch (e) { fail(e, json); }
  },
});

const openReview = sub("open-review", "Wait on a person's review of this agent's plan, opened beside it, and print the decision", {
  plan: { type: "string", description: "plan markdown (or use --file)" },
  file: { type: "string", description: "read the plan from this file ('-' = stdin)" },
  cwd: { type: "string", description: "repo the plan applies to (default: current directory)" },
  timeout: { type: "string", description: "how long to wait for the decision, e.g. 30m (default 24h — pass a Bash-tool timeout to match)" },
  tile: { type: "string", description: "the agent whose plan it is, from a terminal (default: $HIVEMIND_TILE — set inside every spawned agent)" },
}, (a) => {
  let plan = a.plan;
  if (!plan && a.file) plan = a.file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(String(a.file), "utf8");
  if (!plan) throw new UsageError("--plan <markdown> or --file <path> required");
  const callerTile = a.tile || ownTile();
  if (!callerTile) throw new UsageError("not inside a hivemind agent tile ($HIVEMIND_TILE unset) — pass --tile <tileId>");
  const ceiling = durationFlag(a.timeout, "timeout", 24 * 60 * 60 * 1000);
  return hcpCall("review.open", { plan, cwd: a.cwd || process.cwd(), callerTile }, ceiling);
});

// ── stream ───────────────────────────────────────────────────────────────────

/** A screen the host sends in place of what a client shows starts so (spec/workspace-api.md). */
const SCREEN = "\x1bc";

const stream = defineCommand({
  meta: { name: "stream", description: "What an agent prints, ANSI-stripped, as it comes. --lines N prints the last N lines it printed first; --snapshot only those" },
  args: {
    ...tileArg,
    lines: { type: "string", description: "print the last N lines it printed before going live (default with --snapshot: 40)" },
    timeout: { type: "string", description: "stop after this long, e.g. 30s (default: until Ctrl-C, or the agent ends)" },
    snapshot: { type: "boolean", description: "print the last lines it printed and exit (no live tail)" },
    json: { type: "boolean", description: "NDJSON: one {seq,chunk,printed?} per chunk (printed: from before), then {end:true}" },
  },
  async run({ args }) {
    const json = !!args.json;
    try {
      const lines = args.lines != null ? intFlag(args.lines, "lines", 0) : args.snapshot ? 40 : undefined;
      const timeoutMs = durationFlag(args.timeout, "timeout", 0);
      const tile = String(args.tileId);
      const session = tile.startsWith("hm:") ? tile : `hm:${tile}`;
      const d = await openDrive();
      let seq = 0;
      const print = (chunk: string, printed: boolean) => {
        if (!chunk) return;
        if (json) console.log(JSON.stringify({ seq: seq++, chunk, ...(printed ? { printed: true } : {}) }));
        else process.stdout.write(chunk);
      };
      if (lines) print(((await d.call("agent.output", [tile, lines])) as { text: string }).text, true);
      if (!args.snapshot) {
        let end!: () => void;
        const ended = new Promise<void>((r) => (end = r));
        // Its output from now on; a copy of its screen is not output.
        d.on("terminal.data", (at, data) => { if (at === session && !String(data).startsWith(SCREEN)) print(stripAnsi(String(data)), false); });
        d.on("terminal.exit", (at) => { if (at === session) end(); });
        void d.closed.then(end);
        const { pid } = await d.call("terminal.open", [{ tileId: session, cols: 80, rows: 24, attachOnly: true, liveOnly: true }]) as { pid: number };
        if (pid === -1) throw new HcpCliError("NOT_FOUND", `no session runs in tile ${tile}`, EXIT.notFound);
        process.on("SIGINT", end);
        if (timeoutMs) setTimeout(end, timeoutMs).unref();
        await ended;
        d.notice("terminal.detach", [session]);
      }
      d.close();
      if (json) console.log(JSON.stringify({ end: true }));
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

type EmitResult = { id: string; delivered: boolean; view: string; reason?: "no-listener" | "not-active"; buffered?: boolean };

const viewEmit = defineCommand({
  meta: { name: "emit", description: "Send a named JSON event to the active view (`-` reads the JSON from stdin)" },
  args: {
    name: { type: "positional", required: true, description: "dotted lowercase name, e.g. ci.build" },
    payload: { type: "positional", required: false, description: "JSON payload, or - for stdin" },
    view: { type: "string", description: "deliver only while this view is active" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const json = !!args.json;
    try {
      const ev = emitArgs(args.name, args.payload, () => fs.readFileSync(0, "utf8"));
      const r = await onDrive((d) => d.call("view.emit", [ev.name, ev.data, ...(args.view ? [String(args.view)] : [])])) as EmitResult;
      if (json) console.log(JSON.stringify(r));
      else console.log(r.delivered ? `delivered to ${r.view}` : r.reason === "not-active" ? `buffered for ${String(args.view)} (active view is ${r.view})` : `buffered (active view ${r.view} isn't listening)`);
    } catch (e) { fail(e, json); }
  },
});

const view = defineCommand({
  meta: { name: "view", description: "Talk to the active workspace view" },
  subCommands: { emit: viewEmit },
});

type PluginCommands = { plugins: Array<{ plugin: string; kind: string; instance: string; label: string; commands: Array<{ name: string; description: string; args?: string }> }> };

const pluginCommands = defineCommand({
  meta: { name: "commands", description: "What the running plugins (the active view, open tool tiles, widgets) let you run" },
  args: { ...JSON_ARG },
  async run({ args }) {
    const json = !!args.json;
    try {
      const r = await onDrive((d) => d.call("plugin.commands", [])) as PluginCommands;
      if (json) { console.log(JSON.stringify(r)); return; }
      if (!r.plugins.length) { console.log("no running plugin has commands"); return; }
      for (const p of r.plugins) {
        console.log(`${p.plugin}  (${p.kind} ${p.label}, ${p.instance})`);
        for (const c of p.commands) console.log(`  ${c.name.padEnd(18)} ${c.description}${c.args ? `  args: ${c.args}` : ""}`);
      }
    } catch (e) { fail(e, json); }
  },
});

const pluginCall = defineCommand({
  meta: { name: "call", description: "Run a plugin's command and print what it answers (`-` reads the JSON argument from stdin)" },
  args: {
    plugin: { type: "positional", required: true, description: "plugin id, as `hive ctl plugin commands` lists it" },
    command: { type: "positional", required: true, description: "command name" },
    payload: { type: "positional", required: false, description: "JSON argument, or - for stdin" },
    tile: { type: "string", description: "which running copy, when it runs more than once" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const json = !!args.json;
    try {
      const raw = args.payload === "-" ? fs.readFileSync(0, "utf8") : args.payload;
      let payload: unknown = null;
      if (raw !== undefined && raw !== "") {
        try { payload = JSON.parse(String(raw)); } catch { throw new UsageError("the argument must be JSON, e.g. '{\"text\":\"milk\"}'"); }
      }
      const r = await onDrive((d) => d.call("plugin.call", [String(args.plugin), String(args.command), payload, ...(args.tile ? [String(args.tile)] : [])], PLUGIN_CALL_CLIENT_MS)) as { result: unknown };
      console.log(json ? JSON.stringify(r) : typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2));
    } catch (e) { fail(e, json); }
  },
});

const pluginOpen = defineCommand({
  meta: { name: "open", description: "Get a plugin running so its commands can be called: open a tool's tile, add a widget to the board, switch to a view" },
  args: {
    plugin: { type: "positional", required: true, description: "tool:owner/name[/tool], widget:@owner/name or view:id, as `hive plugins list` shows it" },
    frame: { type: "string", description: "frame to open a tool's tile in (default: beside you)" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const json = !!args.json;
    try {
      const r = await onDrive((d) => d.call("plugin.open", [String(args.plugin), ...(args.frame ? [String(args.frame)] : [])])) as { tile?: string; widget?: string; view?: string } & Partial<PluginInstance>;
      if (json) { console.log(JSON.stringify(r)); return; }
      const what = r.tile ? `opened tile ${r.tile}` : r.widget ? `added widget ${r.widget}` : `switched to view ${r.view}`;
      // A plugin with code says whether it can be called yet.
      console.log(r.state === "ready" ? `${what}: ready${r.commands?.length ? ` (${r.commands.map((c) => c.name).join(", ")})` : ""}`
        : r.state === "failed" ? `${what}, and it failed: ${r.reason ?? "it stopped"}`
        : r.state === "starting" ? `${what}: still starting (\`hive ctl plugin list\` shows when it is ready; a call waits for it)` : what);
    } catch (e) { fail(e, json); }
  },
});

const pluginList = defineCommand({
  meta: { name: "list", description: "Every plugin running (tool tiles, widgets with code, the view), each starting, ready or failed; and the views there are" },
  args: { ...JSON_ARG },
  async run({ args }) {
    const json = !!args.json;
    try {
      const r = await onDrive((d) => d.call("plugin.list", [])) as PluginList;
      if (json) { console.log(JSON.stringify(r)); return; }
      if (!r.plugins.length) console.log("no plugin is running");
      for (const p of r.plugins) {
        const offers = p.commands.length ? `  commands: ${p.commands.map((c) => c.name).join(", ")}` : "";
        console.log(`${p.instance}  ${p.kind} ${p.plugin} (${p.label})  ${p.state}${p.reason ? `: ${p.reason}` : ""}${offers}`);
      }
      console.log(`views: ${r.views.map((v) => (v.active ? `${v.id} (shown)` : v.id)).join(", ")}`);
    } catch (e) { fail(e, json); }
  },
});

const pluginClose = sub("close", "Stop a running plugin: close a tool's tile, take a widget off the board, leave a view for the canvas", {
  instance: { type: "positional", required: true, description: "which one, as `hive ctl plugin list` names it" },
  plugin: { type: "string", description: "the plugin it must be (refused when another runs as that instance)" },
}, (args) => onDrive((d) => d.call("plugin.close", [String(args.instance), ...(args.plugin ? [String(args.plugin)] : [])])));

const plugin = defineCommand({
  meta: { name: "plugin", description: "Drive the plugins in the app: list what runs, open one, list and call their commands, close one" },
  subCommands: { list: pluginList, open: pluginOpen, commands: pluginCommands, call: pluginCall, close: pluginClose },
});

export const ctlCmd = defineCommand({
  meta: { name: "ctl", description: "Drive the running hivemind app (spawn/send/read/stream/workflow/report) and the issue verbs agents use" },
  subCommands: {
    agents, frames, "open-tool": openTool, spawn, sessions, send, keys, read, stream, workflow, approve, report, inbox, "open-review": openReview,
    focus, close, rename, connect, disconnect, view, plugin,
    "set-state": setState, "add-comment": addComment, "mark-acceptance": markAcceptance,
    "delete-issue": deleteIssueCmd, "list-workspaces": listWorkspacesCmd,
  },
});
