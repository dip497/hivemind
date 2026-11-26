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
 *   • a result is one JSON object; a failure is `{"error":{"code","message","fix"?}}` (with
 *     --json) or `error [CODE] message` on stderr, with the exit code exit-codes.ts gives it.
 *   • blocking waits are made of short requests (≤ 10 s each) so they
 *     never trip a caller's tool timeout — `read --timeout` is honoured
 *     end-to-end and `--poll` returns immediately. A plugin's command is one
 *     request: 30 s in the window, the host and this CLI each waiting longer
 *     than the hop within, so the reason printed is the innermost one.
 */
import { notesCmd } from "./review.js";
import { codeCommand } from "./ctl-code.js";
import path from "node:path";
import { defineCommand, type ArgsDef, type ParsedArgs } from "citty";
import fs from "node:fs";
import {
  HiveError, commentOnIssue, deleteIssue, issueToJson, listWorkspaces, readIssue, requireRoot, rootForId, updateIssue,
  type IssueState,
} from "@hivemind/core";
import { HcpCliError, hcpCall, ownTile, sockPath } from "../hcp.js";
import { EXIT, exitCodeFor, helpFor, printFailure, type Failure } from "../exit-codes.js";
import { driveSocketPath } from "hivemind-api";
import { appData } from "@hivemind/core/app-data";
import { readTrackedSession, TILE_SESSIONS_DIR } from "@hivemind/agents/node";
import { stripAnsi } from "@hivemind/host/control/output-recorder";
import { openDrive, type Drive } from "../drive.js";
import { notServed, registered, workspaceNamed, type HostWorkspace } from "../workspace-named.js";
import { isRemote } from "@hivemind/core/remote-uri";
import { isAddress } from "@hivemind/core/opener";

type Core = NonNullable<Result<"store.core">>;
import { UnsupportedError, UsageError, boolFlag, emitArgs, durationFlag, intFlag, parseKeys, resolveAgent, superviseOf, workflowPlan } from "../ctl-args.js";
import { readTurn, runWorkflow } from "../workflow.js";
import { ensureAgentCatalog } from "../agent-catalog.js";
import { detectWho } from "../who.js";
import type { AgentItem, InboxMessage } from "@hivemind/workspace-api/agents";
import type { Result } from "@hivemind/workspace-api/methods";
import { BUNDLED_TOOL_PLUGINS } from "@hivemind/core/tool-plugins";
import { createToolRegistry } from "@hivemind/core/tool-registry";
import { listToolPackages } from "@hivemind/core/tool-packages";
import { agentRows, tileRows, type AgentRow, type ToolOf } from "../tile-rows.js";
import { LOOK_MS, PLUGIN_CALL_CLIENT_MS, type PluginInstance, type PluginList, type TileLook } from "@hivemind/workspace-api/plugins";
import type { AlignHow, BoardChange, BoardChangeAsk, BoardChanged, BoardChanges, BoardPicture, BoardReading, BoardSelection } from "@hivemind/workspace-api/board";
import type { PageListing } from "@hivemind/workspace-api/pages";
import os from "node:os";

const ISSUE_STATES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const;

/** Who signs Activity rows: an agent's id when run inside a spawned tile,
 *  else the human at the keyboard. */
function actor(): string {
  return process.env.HIVE_AGENT_ID || process.env.HIVE_ACTOR || detectWho();
}

function print(result: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
}

/** What failed, as every command prints it, and its exit code. */
function failureOf(e: unknown): Failure & { exit: number } {
  const message = String((e as Error)?.message ?? e);
  if (e instanceof HcpCliError) {
    const fix = e.fix ?? (e.exit === EXIT.usage ? helpFor()
      : e.code === "UNAVAILABLE" ? "start the hivemind app, or run `hive host`"
      : e.code === "ASLEEP" ? (/hive ctl wake \S+/.exec(message)?.[0] ?? "hive ctl wake <tile>")
      : e.code === "FILE_TOO_BIG" ? "send a smaller file, or split it"
      : e.code === "NO_PHONE" ? "ask the person to pair a phone with the computer the agent runs on (in the app: Settings → Connect → Connect, then the Phone browser tab)"
      : undefined);
    return { code: e.code, message, ...(fix ? { fix } : {}), exit: e.exit };
  }
  if (e instanceof UsageError) return { code: "USAGE", message, fix: helpFor(), exit: EXIT.usage };
  if (e instanceof UnsupportedError) return { code: "UNSUPPORTED", message, exit: EXIT.refused };
  if (e instanceof HiveError) {
    const code = e.code.toUpperCase();
    return { code, message, exit: code.includes("INVALID") ? EXIT.usage : exitCodeFor(code) };
  }
  if (/not found|does not exist|ENOENT/i.test(message)) return { code: "NOT_FOUND", message, exit: EXIT.notFound };
  if (/out of range|required|must be/i.test(message)) return { code: "BAD_REQUEST", message, fix: helpFor(), exit: EXIT.usage };
  return { code: "FAILED", message, exit: EXIT.error };
}

function fail(e: unknown, json: boolean): never {
  const { exit, ...failure } = failureOf(e);
  return printFailure(json, failure, exit);
}

const JSON_ARG = { json: { type: "boolean", description: "print the result as JSON on one line" } } as const;

/** defineCommand with `--json`, structured errors and exit codes wired in. */
export function sub<A extends ArgsDef>(
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

const tileArg = { tileId: { type: "positional", required: true, description: "the tile, by its id (from `hive ctl spawn` or `hive ctl agents`)" } } as const;

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

/** The workspace a command acts on: for the person, the one `--repo` names or else the one this
 *  folder is in (`workspaceNamed`); for an agent or a program, `--repo`'s folder, else its own. */
async function workspaceOf(d: Drive, repo: unknown): Promise<string> {
  const given = typeof repo === "string" && repo ? repo : null;
  if (d.as !== "person") return given ? (isRemote(given) ? given : path.resolve(given)) : d.as.workspace;
  const { workspaces } = (await d.call("host.status", [])) as { workspaces: HostWorkspace[] };
  const named = workspaceNamed(workspaces, given, process.cwd(), await registered());
  if ("refused" in named) throw new UsageError(named.refused);
  if ("unserved" in named) throw new UsageError(notServed(named.unserved));
  return named.repo;
}

const repoArg = { repo: { type: "string", description: "the workspace: for the person, its folder, name, id or prefix (default: the one this folder is in); an agent or a grant drives only its own, by its folder (`hive ctl whoami` says which)" } } as const;

/** Which app `hive ctl` reaches and as whom. */
interface WhoAmI {
  /** "hivemind" for the release app, "hivemind-dev" for a dev run: the app data folder's name. */
  instance: string;
  appData: string;
  driveSocket: string;
  hcpSocket: string;
  running: boolean;
  as: "person" | "agent" | "program" | null;
  /** A program's grant, by its name. */
  grant?: string;
  workspace: string | null;
  tile: string | null;
  /** The agent's session, once its hooks have said it. */
  session: string | null;
}

/** The app data folder a socket is in; null for a named pipe, which names none. */
const folderOfSocket = (sock: string): string | null => (sock.startsWith("\\\\.\\pipe\\") ? null : path.dirname(sock));

/** The data folder of the app `hive ctl` reaches: where its drive socket is, else the default. */
const appDataReached = (): string => folderOfSocket(driveSocketPath()) ?? appData();

async function whoAmI(): Promise<WhoAmI> {
  const driveSocket = driveSocketPath();
  const hcpSocket = sockPath();
  const folder = appDataReached();
  const tile = ownTile()?.replace(/^hm:/, "") ?? null;
  const here = { instance: path.basename(folder), appData: folder, driveSocket, hcpSocket };
  let d: Drive;
  try {
    d = await openDrive();
  } catch (e) {
    if (e instanceof HcpCliError && e.code === "UNAVAILABLE") return { ...here, running: false, as: null, workspace: null, tile, session: null };
    throw e;
  }
  try {
    if (d.as === "person") {
      const workspace = await workspaceOf(d, undefined).catch(() => null);
      return { ...here, running: true, as: "person", workspace, tile, session: null };
    }
    if ("client" in d.as) return { ...here, running: true, as: "program", grant: d.as.client, workspace: d.as.workspace, tile: null, session: null };
    const me = d.as.agent;
    const listed = await d.call("agent.list", [d.as.workspace]).catch(() => null) as { agents: Array<{ tile: string; session?: string }> } | null;
    const session = listed?.agents.find((a) => a.tile === me)?.session ?? null;
    return { ...here, running: true, as: "agent", workspace: d.as.workspace, tile: me, session };
  } finally {
    d.close();
  }
}

const whoami = defineCommand({
  meta: { name: "whoami", description: "Which app this reaches and as whom: its data folder and sockets, hivemind or hivemind-dev, the workspace, your tile and session" },
  args: { ...JSON_ARG },
  async run({ args }) {
    const json = !!args.json;
    try {
      const me = await whoAmI();
      if (json) console.log(JSON.stringify(me));
      else {
        const as = me.as === null ? "nobody: no app or host answers on the drive socket" : me.grant ? `program (grant ${me.grant})` : me.as;
        console.log([
          `instance   ${me.instance}`, `app data   ${me.appData}`, `drive      ${me.driveSocket}`, `hcp        ${me.hcpSocket}`,
          `as         ${as}`, `workspace  ${me.workspace ?? "none"}`, `tile       ${me.tile ?? "none"}`,
          `session    ${me.session ?? (me.as === "agent" ? "not known yet: its agent has not said it" : "none")}`,
        ].join("\n"));
      }
      if (!me.running) process.exit(EXIT.unavailable);
    } catch (e) { fail(e, json); }
  },
});

type FeedEvent = { seq: number; kind: string; tile: string; detail?: string };

/** One agent as a line: its tile, name, program, state, what it waits on, and its last line. */
const agentLine = (a: AgentRow): string => `${a.tile}\t${a.name}\t${a.agent ?? "-"}\t${a.state}${a.waiting ? `\twaiting: ${a.waiting.kind}` : ""}${a.line ? `\tline: ${a.line}` : ""}`;

// The workspace's agents, as the app's agent feed says; --watch follows what happens to them.
const agents = defineCommand({
  meta: { name: "agents", description: "The workspace's agents: tile, name, agent (the program, as spawn --agent takes it), workspace {id, name}, state (asleep when put to sleep), what each waits on and its last line; --watch follows what happens to them" },
  args: {
    ...repoArg,
    watch: { type: "boolean", description: "keep going: print each turn ended, wait and answer as it happens (one JSON per line with --json)" },
    session: { type: "string", description: "only the agent in this session (its id, as `hive ctl sessions` or its hooks give it); exit 5 when none is" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const json = !!args.json;
    try {
      if (args.session && args.watch) throw new UsageError("--session lists once: it does not go with --watch");
      const d = await openDrive();
      const repo = await workspaceOf(d, args.repo);
      // Heard from before the list, so nothing that happens meanwhile is missed.
      const heard: FeedEvent[] = [];
      let show = (e: FeedEvent) => { heard.push(e); };
      d.on("agent.event", (at, e) => { if (at === repo) show(e as FeedEvent); });
      let listed = await d.call("agent.list", [repo]) as { seq: number; agents: AgentItem[] };
      if (args.session) {
        const id = String(args.session);
        // What its hooks last said, or the session the app tracks for its tile to resume.
        const tracked = path.join(appDataReached(), TILE_SESSIONS_DIR);
        const inIt = listed.agents.filter((a) => a.session === id || readTrackedSession(tracked, `hm:${a.tile}`) === id);
        if (!inIt.length) { d.close(); throw new HcpCliError("NOT_FOUND", `no agent of the workspace at ${repo} is in session ${id}`, EXIT.notFound); }
        listed = { ...listed, agents: inIt };
      }
      // Each one's last line, read once (a host before 0.35 has none to give).
      const lines = await (d.call("tile.readLines", [listed.agents.map((a) => a.tile)]) as Promise<{ lines: Record<string, string> }>)
        .then((r) => r.lines, () => ({}));
      const rows = agentRows(listed.agents, await d.call("store.core", [repo]) as Core | null, lines);
      if (!args.watch) {
        d.close();
        if (json) return console.log(JSON.stringify({ seq: listed.seq, agents: rows }));
        console.log(rows.map(agentLine).join("\n") || "no agents");
        return;
      }
      if (!json) for (const a of rows) console.log(agentLine(a));
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

/** The plugin and tool each tool tile kind is of, as the tool plugins here say. */
async function toolKinds(): Promise<ToolOf> {
  const added = await listToolPackages().catch(() => []);
  const registry = createToolRegistry([...BUNDLED_TOOL_PLUGINS, ...added.filter((t) => !t.problem)]);
  return (kind) => {
    const tool = registry.tileKindOwner(kind);
    const plugin = tool ? registry.tools.find((t) => t.id === tool)?.pluginId : undefined;
    return tool && plugin ? { plugin, tool } : null;
  };
}

const tiles = defineCommand({
  meta: { name: "tiles", description: "Every tile of the workspace: tile, kind (agent, terminal, tool, …), name, frame, an agent's state and program, a tool's plugin" },
  args: { ...repoArg, ...JSON_ARG },
  async run({ args }) {
    const json = !!args.json;
    try {
      const rows = await onDrive(async (d) => {
        const repo = await workspaceOf(d, args.repo);
        const core = await d.call("store.core", [repo]) as Core | null;
        if (!core) throw new HcpCliError("NOT_FOUND", `no workspace is open at ${repo}`, EXIT.notFound);
        const { agents } = await d.call("agent.list", [repo]) as { agents: AgentItem[] };
        await ensureAgentCatalog();
        return tileRows(core, agents, await toolKinds());
      });
      if (json) return console.log(JSON.stringify({ tiles: rows }));
      console.log(rows.map((t) => [t.tile, t.kind, t.name, t.frame ?? "-", t.state ?? t.agent ?? t.plugin ?? ""].join("\t")).join("\n") || "no tiles");
    } catch (e) { fail(e, json); }
  },
});

const frames = sub("frames", "The workspace's frames, where an agent may be started (id, name, machine)", repoArg,
  (a) => onDrive(async (d) => ({ frames: ((await d.call("agent.startable", [await workspaceOf(d, a.repo)])) as { frames: unknown[] }).frames })));

const frameAdd = sub("add", "Open a frame on a folder: on another machine with --machine (a saved machine or another of your devices, by id or name); prints { frame, path, opened }. A folder that has a frame already gives that frame", {
  folder: { type: "string", required: true, description: "the folder, given in full (on that machine with --machine)" },
  machine: { type: "string", description: "the machine the folder is on, by its id or name (`hive machine list`, Settings ▸ Devices); default: this one" },
  name: { type: "string", description: "the frame's name (default: the folder's)" },
  ...repoArg,
}, (a) => onDrive(async (d) => d.call("frame.open", [await workspaceOf(d, a.repo), {
  path: String(a.folder),
  ...(a.machine ? { machine: String(a.machine) } : {}),
  ...(a.name ? { title: String(a.name) } : {}),
}])));

const frame = defineCommand({
  meta: { name: "frame", description: "Make frames: `add` opens one on a folder, here or on another machine" },
  subCommands: { add: frameAdd },
});

/** `--frame`: a frame of the workspace by its id, or by its name in any case, as `frames` lists them. */
async function frameIn(d: Drive, repo: string, given: string): Promise<string> {
  const { frames } = await d.call("agent.startable", [repo]) as { frames: Array<{ id: string; name: string }> };
  const frame = frames.find((f) => f.id === given) ?? frames.find((f) => f.name.toLowerCase() === given.toLowerCase());
  if (!frame) throw new HcpCliError("NOT_FOUND", `no frame ${given} in this workspace: \`hive ctl frames\` lists them`, EXIT.notFound);
  return frame.id;
}

const openTool = sub("open-tool", "Open an enabled tool plugin", {
  tool: { type: "positional", required: true, description: "tool id, as `hive plugins list` prints it (@hivemind/web/browser), or its package id when the package has one tool (@hivemind/web)" },
  frame: { type: "string", description: "target frame (id, repo name, or title; default: beside the calling agent, else the one selected); exit 5 when none answers to it" },
  url: { type: "string", description: "Browser URL: http, https, or about:blank" },
  state: { type: "string", description: "the tile's first state, a JSON object: what the tool's useTileState(hm, key, …) reads under each key" },
  ...repoArg,
}, (a) => {
  let state: unknown;
  if (a.state) {
    try { state = JSON.parse(String(a.state)); } catch { throw new UsageError(`--state must be JSON: ${String(a.state).slice(0, 80)}`); }
  }
  return onDrive(async (d) => d.call("tool.open", [await workspaceOf(d, a.repo), { tool: a.tool, ...(a.frame ? { frame: a.frame } : {}), ...(a.url ? { url: a.url } : {}), ...(state !== undefined ? { state } : {}) }]));
});

/** Longer than this and an agent's own tool may give up on the command: the wait starts again with `wait`. */
const BROWSER_ASK_WAIT_MS = 110_000;
const browserTileArg = { tile: { type: "string", description: "the Browser tile (default: the one beside you)" } } as const;
const browserWaitArg = { timeout: { type: "string", description: `how long to wait, e.g. 90s (default ${BROWSER_ASK_WAIT_MS / 1000}s); the question stays up after that` } } as const;
/** Wait, in short requests, for how question `ask` ends: its exit code says how it did. */
async function browserAnswer(d: Drive, ask: number, tile: string | undefined, total: number) {
  const until = Date.now() + total;
  for (;;) {
    const left = until - Date.now();
    const state = await d.call("browser.askState", [ask, Math.max(0, Math.min(left, 10_000))]) as Result<"browser.askState">;
    if (state.state === "done") {
      const result = { ask, ...(tile ? { tile } : {}), ...state };
      if (state.outcome === "done" || state.outcome === "sent") return result;
      return { __exit: state.outcome === "expired" ? EXIT.timeout : EXIT.refused, result };
    }
    if (left <= 0) return { __exit: EXIT.timeout, result: { ask, ...(tile ? { tile } : {}), state: state.state, fix: `still up: hive ctl browser wait ${ask}` } };
  }
}
const browser = defineCommand({
  meta: { name: "browser", description: "Ask the person on a Browser tile, and sign in with a saved sign-in: the password never reaches you" },
  subCommands: {
    "sign-ins": sub("sign-ins", "List the saved sign-ins, by name and site", {}, () => onDrive((d) => d.call("browser.signIns", []))),
    "sign-in": sub("sign-in", "Sign in on a Browser tile with a saved sign-in, once the person says yes there", {
      name: { type: "positional", required: true, description: "its name: hive ctl browser sign-ins" },
      ...browserTileArg, ...browserWaitArg,
    }, (a) => onDrive(async (d) => {
      const { ask, tile } = await d.call("browser.signIn", [String(a.name), a.tile]) as Result<"browser.signIn">;
      return browserAnswer(d, ask, tile, durationFlag(a.timeout, "timeout", BROWSER_ASK_WAIT_MS));
    })),
    ask: sub("ask", "Ask the person to do something in a Browser tile's page themselves, such as sign in; you wait, and see nothing of it", {
      words: { type: "positional", required: true, description: "what you ask them to do" },
      ...browserTileArg, ...browserWaitArg,
    }, (a) => onDrive(async (d) => {
      const { ask, tile } = await d.call("browser.ask", [String(a.words), a.tile]) as Result<"browser.ask">;
      return browserAnswer(d, ask, tile, durationFlag(a.timeout, "timeout", BROWSER_ASK_WAIT_MS));
    })),
    wait: sub("wait", "Go on waiting for a question's answer", {
      ask: { type: "positional", required: true, description: "its number" },
      ...browserWaitArg,
    }, (a) => onDrive((d) => browserAnswer(d, intFlag(a.ask, "ask", 0), undefined, durationFlag(a.timeout, "timeout", BROWSER_ASK_WAIT_MS)))),
    asks: sub("asks", "The questions waiting on the person", {}, () => onDrive((d) => d.call("browser.asks", []))),
    answer: sub("answer", "The person's answer to a question: yes, always, no or done", {
      ask: { type: "positional", required: true, description: "its number" },
      answer: { type: "positional", required: true, description: "yes | always | no | done" },
    }, (a) => onDrive((d) => d.call("browser.answer", [intFlag(a.ask, "ask", 0), String(a.answer) as "yes"]))),
  },
});

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
const turnExit = { closed: EXIT.notFound, waiting: EXIT.waiting, idle: EXIT.refused, timeout: EXIT.timeout, working: EXIT.ok } as const;

const read = sub("read", "Wait for an agent's turn to finish and print its reply (exit 4 on timeout, 5 if it closes or the tile runs no agent, 7 if it is idle with nothing new, 8 if it stops to wait on an answer, 9 if it is asleep)", {
  ...tileArg,
  timeout: { type: "string", description: `total wait, e.g. 90s or 5m (default ${READ_DEFAULT_MS / 1000}s); made of short HCP polls, never one long request` },
  poll: { type: "boolean", description: "don't wait: say now whether it has a new reply, is working, idle, waiting, asleep or closed (exit 0)" },
}, async (a) => {
  const total = a.poll ? 0 : durationFlag(a.timeout, "timeout", READ_DEFAULT_MS);
  return onDrive(async (d) => {
    const r = await readTurn(d, String(a.tileId), total);
    if (r.finalStatus === "turn" || a.poll) return r;
    // Closed while we waited: no turn is coming. Waiting: none comes until it is answered; idle,
    // until it is sent a task.
    return { __exit: turnExit[r.finalStatus], result: r };
  });
});

const ask = sub("ask", "Send text to an agent and print its answer in one call (exit 4 on timeout, 5 if it closes, 8 if it stops to wait on an answer, 9 if it is asleep)", {
  ...tileArg, text: { type: "positional", required: true },
  timeout: { type: "string", description: `how long to wait for the answer, e.g. 90s or 5m (default ${READ_DEFAULT_MS / 1000}s)` },
}, (a) => {
  const total = durationFlag(a.timeout, "timeout", READ_DEFAULT_MS);
  return onDrive(async (d) => {
    const sent = await d.call("agent.send", [a.tileId, a.text]) as { sent: boolean };
    if (!sent.sent) throw notFound(a.tileId);
    const r = await readTurn(d, String(a.tileId), total);
    return r.finalStatus === "turn" ? r : { __exit: turnExit[r.finalStatus], result: r };
  });
});

const asAgent = (given: unknown): string => {
  const callerTile = (typeof given === "string" && given) || ownTile();
  if (!callerTile) throw new UsageError("not inside a hivemind agent tile ($HIVEMIND_TILE unset) — pass --tile <tileId>");
  return callerTile;
};
const agentTileArg = { tile: { type: "string", description: "the agent doing this, from a terminal (default: $HIVEMIND_TILE — set inside every spawned agent)" } } as const;
const channelArg = { channel: { type: "positional", required: true, description: "channel name: lowercase letters, digits and dashes" } } as const;
const restOf = (a: { _?: string[] }, skip = 0): string[] => (a._ ?? []).slice(skip);
const absolutePaths = (given: string[]): string[] => given.map((p) => path.resolve(p));

const post = sub("post", "Post to a channel: every agent following it finds it in its inbox, and an @name in the text reaches that agent even if it does not follow. Posting follows the channel",
  { ...channelArg, text: { type: "positional", required: true }, ...agentTileArg },
  (a) => hcpCall("agent.post", { callerTile: asAgent(a.tile), channel: a.channel, text: a.text }));

const follow = sub("follow", "Follow a channel: what agents post to it comes to your inbox", { ...channelArg, ...agentTileArg },
  (a) => hcpCall("agent.follow", { callerTile: asAgent(a.tile), channel: a.channel }));

const unfollow = sub("unfollow", "Stop following a channel", { ...channelArg, ...agentTileArg },
  (a) => hcpCall("agent.leave", { callerTile: asAgent(a.tile), channel: a.channel }));

const channelsCmd = sub("channels", "The channels you follow and who else follows each", agentTileArg,
  (a) => hcpCall("agent.channels", { callerTile: asAgent(a.tile) }));

type HeldClaim = { path: string; by: string; name: string; since: number; note?: string };

const claim = sub("claim", "Claim files before you edit them, all or none (exit 7 when another agent holds one: it says who)",
  { note: { type: "string", description: "what you are doing with them" }, ...agentTileArg },
  async (a) => {
    const paths = absolutePaths(restOf(a));
    if (!paths.length) throw new UsageError("name at least one file: hive ctl claim <path…>");
    const r = await hcpCall("agent.claim", { callerTile: asAgent(a.tile), paths, ...(a.note ? { note: a.note } : {}) }) as { claimed: string[]; held: HeldClaim[] };
    if (!r.held.length) return r;
    const holders = [...new Set(r.held.map((c) => `${c.name} (${c.by})`))].join(", ");
    throw new HcpCliError("CLAIMED", `held by another agent: ${r.held.map((c) => `${c.path} by ${c.name}${c.note ? ` (${c.note})` : ""}`).join("; ")}`, EXIT.refused,
      `ask ${holders} to release, e.g. hive ctl send ${r.held[0]!.by} "Please release ${r.held[0]!.path}", or work on other files`);
  });

const release = sub("release", "Release files you claimed; with no path, every one you hold", agentTileArg,
  (a) => hcpCall("agent.release", { callerTile: asAgent(a.tile), paths: absolutePaths(restOf(a)) }));

const claims = sub("claims", "Every file an agent has claimed, and who holds it", {}, () => hcpCall("agent.claims", {}));

const focus = sub("focus", "Bring a tile forward in the window; prints { focused }", tileArg, (a) => onDrive(async (d) => {
  await d.call("tile.focus", [a.tileId]);
  return { focused: String(a.tileId) };
}));
const open = sub("open", "Open a web address or a file, path[:line[:col]], where a click would: a Browser tile or the system's browser, the Code tile at that line, the Image tile; prints { to, tile?, path?, url? }. Exit 7 when the app would ask the person (a path outside the workspace, an unknown kind of link), 5 when the file is not there",
  {
    thing: { type: "positional", required: true, description: "a URL, or a path relative to here with an optional :line:col" },
    tile: { type: "string", description: "open it as a click in this tile's frame (an agent opens in its own)" },
  },
  (a) => {
    const thing = String(a.thing);
    const target = isAddress(thing) ? thing : path.resolve(thing);
    return onDrive((d) => d.call("opener.open", a.tile ? [target, a.tile] : [target])).catch((e: unknown) => {
      if (!(e instanceof HcpCliError) || e.code !== "UNSUPPORTED") throw e;
      throw new HcpCliError(e.code, e.message, e.exit, /never/.test(e.message) ? "this kind of link is never opened"
        : /allow|person/.test(e.message) ? "only the person can open this kind of link, by clicking it; give them the link instead"
        : "open a file inside a workspace: hive ctl frames lists their folders");
    });
  });
const close = sub("close", "Close an agent: its session ends and its tile goes", tileArg, (a) => onDrive(async (d) => {
  const r = await d.call("agent.close", [a.tileId]) as { closed: boolean };
  if (!r.closed) throw notFound(a.tileId);
  return r;
}));
/** A tile or a frame of the workspace, by its id or name; none: all of it. */
const targetArg = { target: { type: "positional", required: false, description: "a tile or a frame, by its id or name (none: every agent of the workspace)" } } as const;
type Skipped = Array<{ tile: string; why: string; already?: true }>;
/** Refused when nothing was done and something was left for a reason other than being so already,
 *  so a script can tell; asleep or awake already is what was asked. */
const doneOrRefused = (done: string[], skipped: Skipped, result: unknown) => (done.length === 0 && skipped.some((s) => !s.already) ? { __exit: EXIT.refused, result } : result);

const sleep = sub("sleep", "Put agents to sleep: each one's process ends, and its last screen and conversation wait for `hive ctl wake`. With no target, every agent but the one asking",
  { ...targetArg, force: { type: "boolean", description: "also those working or waiting on someone" }, ...repoArg },
  (a) => onDrive(async (d) => {
    const r = await d.call("agent.sleep", [await workspaceOf(d, a.repo), a.target ?? "", !!a.force]) as { slept: string[]; skipped: Skipped };
    return doneOrRefused(r.slept, r.skipped, r);
  }));
const wake = sub("wake", "Wake agents put to sleep: each starts again in its conversation", { ...targetArg, ...repoArg },
  (a) => onDrive(async (d) => {
    const r = await d.call("agent.wake", [await workspaceOf(d, a.repo), a.target ?? ""]) as { woke: string[]; skipped: Skipped };
    return doneOrRefused(r.woke, r.skipped, r);
  }));
const rename = sub("rename", "Name an agent; with no name, take its name away",
  { ...tileArg, name: { type: "positional", required: false, description: "the name every surface shows it by" } },
  (a) => onDrive((d) => d.call("agent.rename", [a.tileId, a.name ?? ""])));

const connect = sub("connect", "Send src agent's finished replies to dst's inbox, not its input: dst is told by one line typed into it (\"[hive] Your agents sent you messages. Read them: hive ctl inbox\"), which starts a turn of its own",
  { src: { type: "positional", required: true, description: "the agent whose replies are sent, by its tile id" }, dst: { type: "positional", required: true, description: "the agent whose inbox gets them, by its tile id" } },
  (a) => onDrive(async (d) => {
    await d.call("link.connect", [a.src, a.dst]);
    return { connected: { src: String(a.src), dst: String(a.dst) } };
  }));

const disconnect = sub("disconnect", "Remove pipes from src (optionally only to one dst)",
  { src: { type: "positional", required: true }, dst: { type: "positional", required: false } },
  (a) => onDrive(async (d) => {
    await d.call("link.disconnect", a.dst ? [a.src, a.dst] : [a.src]);
    return { disconnected: { src: String(a.src), dst: a.dst ? String(a.dst) : null } };
  }));

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
    const gone = () => new HcpCliError("NOT_FOUND", `no approval ${String(a.reqId)} is waiting: it was answered, ran out of time, or its worker stopped waiting`, EXIT.notFound, "`hive ctl inbox` lists the approvals asked of you");
    if (!asking) throw gone();
    const r = await d.call("agent.answer", [asking.tile, asking.waiting!.since, answer]) as { answered: boolean };
    if (!r.answered) throw gone();
    return r;
  });
});

const approval = sub("approval", "Show what a supervised worker's approval request would do, its tool's input whole", {
  reqId: { type: "positional", required: true },
  ...repoArg,
}, (a) => onDrive(async (d) => {
  const { agents } = await d.call("agent.list", [await workspaceOf(d, a.repo)]) as { agents: Waiting[] };
  const asking = agents.find((w) => w.waiting?.approval?.request === a.reqId);
  if (!asking) throw new HcpCliError("NOT_FOUND", `no approval ${String(a.reqId)} is waiting: it was answered, ran out of time, or its worker stopped waiting`, EXIT.notFound);
  return d.call("agent.approval", [asking.tile]);
}));

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
  `── #${m.id} ${m.kind}${m.channel ? ` in #${m.channel}` : ""} from ${m.name}${m.turn !== undefined ? `, turn ${m.turn}` : ""} ──\n${m.text}`;

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
  return { activity: after.sections.activity.slice(-3) };
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
  return { criterion: ac[index] };
});

const deleteIssueCmd = sub("delete-issue", "Delete an issue file (irreversible)", {
  id: { type: "positional", required: true },
}, async (a) => {
  const r = await rootForId(await requireRoot(), String(a.id));
  await deleteIssue(r, String(a.id));
  return { deleted: String(a.id) };
});

const listWorkspacesCmd = defineCommand({
  meta: { name: "list-workspaces", description: "List every registered workspace: its prefix, title and folder (`repo` in --json)" },
  args: { ...JSON_ARG },
  async run({ args }) {
    const json = !!args.json;
    try {
      const all = (await listWorkspaces({ persistPrune: true })).map((w) => ({ prefix: w.prefix, title: w.title, repo: w.repo }));
      if (json) console.log(JSON.stringify({ workspaces: all }));
      else console.log(all.map((w) => `${w.prefix}\t${w.title}\t${w.repo}`).join("\n") || "no workspaces registered");
    } catch (e) { fail(e, json); }
  },
});

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
  meta: { name: "open", description: "Get a plugin running so its commands can be called: open a tool's tile, add a widget to the board, switch to a view; a widget already there, by its id, is shown over every view" },
  args: {
    plugin: { type: "positional", required: true, description: "tool:@owner/name[/tool], widget:@owner/name or view:id, as `hive plugins list` shows it; or a widget's id, as `hive ctl plugin list` shows it" },
    frame: { type: "string", description: "frame to open a tool's tile in (default: beside you)" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const json = !!args.json;
    try {
      const r = await onDrive((d) => d.call("plugin.open", [String(args.plugin), ...(args.frame ? [String(args.frame)] : [])])) as { tile?: string; widget?: string; view?: string } & Partial<PluginInstance>;
      // Open but failed is a failure to branch on; what it opened is still printed, to look at or close.
      if (r.state === "failed") process.exitCode = EXIT.error;
      if (json) { console.log(JSON.stringify(r)); return; }
      const placed = /^(?:widget:)?(.+)$/.exec(String(args.plugin))?.[1] === r.widget;
      const what = r.tile ? `opened tile ${r.tile}` : r.widget ? (placed ? `widget ${r.widget} shows over every view` : `added widget ${r.widget}`) : `switched to view ${r.view}`;
      // A plugin with code says whether it can be called yet.
      console.log(r.state === "ready" ? `${what}: ready${r.commands?.length ? ` (${r.commands.map((c) => c.name).join(", ")})` : ""}`
        : r.state === "failed" ? `${what}, and it failed: ${r.reason ?? "it stopped"}`
        : r.state === "starting" ? `${what}: still starting (\`hive ctl plugin list\` shows when it is ready; a call waits for it)` : what);
    } catch (e) { fail(e, json); }
  },
});

const pluginList = defineCommand({
  meta: { name: "list", description: "Every plugin running (tool tiles, widgets with code, the view), each starting, ready or failed; the views there are; and every widget in the workspace, with the view it shows over alone" },
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
      for (const w of r.widgets) {
        const where = w.placement === "board" ? "on the board" : w.view ? `over ${w.view} alone` : "over every view";
        console.log(`widget ${w.instance}  ${w.widget}  ${where}${w.running ? "" : "  (not running)"}`);
      }
    } catch (e) { fail(e, json); }
  },
});

const pluginClose = sub("close", "Close a plugin: close a tool's tile, take a widget off the board (one drawn without code too), leave a view for the canvas", {
  instance: { type: "positional", required: true, description: "which one: its instance, as `hive ctl plugin list` names it, a widget's id on the board, or the plugin as `plugin open` takes it (widget:@owner/name, tool:@owner/name, view:id) when one copy is open" },
  plugin: { type: "string", description: "the plugin it must be (refused when another runs as that instance)" },
}, (args) => onDrive((d) => d.call("plugin.close", [String(args.instance), ...(args.plugin ? [String(args.plugin)] : [])])));

const tileLook = sub("look", "Bring a tile into view, wait for it to draw, and save a picture of it with its plugin's state and console", {
  ...tileArg,
  out: { type: "string", description: "where the PNG goes (default: a new file in the temp folder)" },
}, async (a) => {
  const seen = await onDrive((d) => d.call("tile.look", [a.tileId], LOOK_MS + 10_000)) as TileLook;
  const file = path.resolve(a.out ? String(a.out) : path.join(os.tmpdir(), `hive-look-${seen.tile.replace(/[^\w-]/g, "_")}-${Date.now()}.png`));
  fs.writeFileSync(file, Buffer.from(seen.png, "base64"));
  const { png: _, ...rest } = seen;
  return { ...rest, png: file };
});

const fileTileArg = { tile: { type: "string", description: "the agent, from a terminal (default: $HIVEMIND_TILE — set inside every spawned agent, which sends only as itself)" } } as const;
const agentForFiles = (given: string | undefined): string => {
  const tile = given || ownTile();
  if (!tile) throw new UsageError("not inside a hivemind agent tile ($HIVEMIND_TILE unset) — pass --tile <tileId>");
  return tile;
};

const sendFile = sub("send-file", "Send a file to the person's phone, where it shows in this agent's chat to save. The computer keeps a copy for 7 days, and the phone fetches it when next open: ready does not mean they have it", {
  file: { type: "positional", required: true, description: "the file, on the computer the agent runs on; at most 32 MiB" },
  ...fileTileArg,
}, async (a) => {
  const sent = await onDrive((d) => d.call("agent.sendFile", [agentForFiles(a.tile), path.resolve(String(a.file))])) as Record<string, unknown>;
  return { ...sent, ready: `Ready for the person's phone, kept for 7 days. It has not necessarily reached them yet.` };
});
const sentFilesCmd = sub("sent-files", "List the files this agent sent the person's phone that are still kept, oldest first", fileTileArg,
  (a) => onDrive((d) => d.call("agent.sentFiles", [agentForFiles(a.tile)])));
const takeBackFile = sub("take-back-file", "Remove a file this agent sent, by its id (from `hive ctl sent-files`), so the phone no longer shows or fetches it", {
  id: { type: "positional", required: true, description: "the file's id" },
}, (a) => onDrive(async (d) => {
  const r = await d.call("agent.takeBackFile", [String(a.id)]) as { takenBack: boolean };
  if (!r.takenBack) throw new HcpCliError("NOT_FOUND", `no file ${String(a.id)} is kept here`, EXIT.notFound);
  return r;
}));

// ── the board: drawing on it, reading it, pinning notes ──────────────

const pointFlag = (v: unknown, name: string): { x: number; y: number } | undefined => {
  if (v === undefined || v === "") return undefined;
  const [x, y, more] = String(v).split(",").map(Number);
  if (more !== undefined || !Number.isFinite(x) || !Number.isFinite(y)) throw new UsageError(`--${name} must be x,y on the canvas: ${String(v)}`);
  return { x: x!, y: y! };
};

/** What to draw: the JSON in `--file`, or on stdin. */
function drawingAsked(file: unknown): Record<string, unknown> {
  const from = file ? String(file) : 0;
  let raw: string;
  try {
    raw = fs.readFileSync(from, "utf8");
  } catch (e) {
    throw new UsageError(`cannot read ${file ? String(file) : "stdin"}: ${(e as Error).message}`);
  }
  let asked: unknown;
  try {
    asked = JSON.parse(raw);
  } catch {
    throw new UsageError(`what to draw must be JSON, on stdin or in --file: ${raw.slice(0, 80)}`);
  }
  if (typeof asked !== "object" || asked === null || Array.isArray(asked)) throw new UsageError("what to draw must be a JSON object: {title, boxes, links, shapes}");
  return asked as Record<string, unknown>;
}

type BoardImage = Result<"board.keepImage">;
const IMAGE_HASH = /^[0-9a-f]{64}$/;
/** How wide a picture put on the board alone is at most, as the window places one. */
const PLACED_IMAGE_MOST = 640;
const IMAGE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/** The picture in `file` kept for the board: what the board shows of it. The host reads what it is from its bytes. */
async function keptImage(d: Drive, repo: string, file: string): Promise<BoardImage> {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    throw new UsageError(`cannot read ${file}: ${(e as Error).message}`);
  }
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()] ?? "image/png";
  return await d.call("board.keepImage", [repo, { type, data: bytes.toString("base64") } as never]) as BoardImage;
}

/** Each box of `asked` whose `image` is a file, kept and named by its hash instead. */
async function imagesKept(d: Drive, repo: string, asked: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!Array.isArray(asked.boxes)) return asked;
  const boxes = [];
  for (const box of asked.boxes as unknown[]) {
    const image = (box as { image?: unknown } | null)?.image;
    boxes.push(typeof image === "string" && !IMAGE_HASH.test(image) ? { ...(box as object), image: (await keptImage(d, repo, image)).hash } : box);
  }
  return { ...asked, boxes };
}

/** Each problem as a line a person or an agent reads: what is wrong, then what to do. */
function printProblems(problems: ReadonlyArray<{ say: string; fix: string }>): void {
  for (const p of problems) console.error(`problem: ${p.say}\n  fix: ${p.fix}`);
}

/** What a board or page verb answers: its result, the line printed without --json (the result
 *  itself when none), and its exit code when that is not 0. */
interface Said { result: unknown; line?: string; exit?: number }

/** What to do next when the board refuses, by error code. */
const BOARD_FIXES: Readonly<Record<string, string>> = {
  NOT_FOUND: "`hive ctl board --json` lists what is drawn, `hive ctl page list` the pages",
  FORBIDDEN: "the person locked it, or shared this board with you to view only: ask them",
  UNSUPPORTED: "open the workspace in the Hivemind app: `hive host` has no window",
};

/** A board or page verb: `--json`, a plain line otherwise, and a refusal with what to do next. */
function said<A extends ArgsDef>(name: string, description: string, args: A, run: (args: ParsedArgs<A & typeof JSON_ARG>) => Promise<Said>) {
  return defineCommand({
    meta: { name, description },
    args: { ...args, ...JSON_ARG },
    async run({ args }) {
      const json = !!args.json;
      try {
        const r = await run(args as ParsedArgs<A & typeof JSON_ARG>);
        console.log(json ? JSON.stringify(r.result) : r.line ?? JSON.stringify(r.result, null, 2));
        if (r.exit) process.exit(r.exit);
      } catch (e) {
        if (e instanceof HcpCliError && !e.fix && BOARD_FIXES[e.code]) e.fix = BOARD_FIXES[e.code];
        fail(e, json);
      }
    },
  });
}

/** A page or frame named on the command line: `top` is the whole canvas (null); left out, undefined. */
function pageFlag(v: unknown): string | null | undefined {
  if (v === undefined || v === "") return undefined;
  return String(v) === "top" ? null : String(v);
}

const pageArg = { page: { type: "string", description: "inside this page or frame, at any depth: its id from `hive ctl page list` or `hive ctl frames`, or top for the whole canvas" } } as const;

const draw = said("draw", "Draw on the board: JSON on stdin or in --file, {title?, direction?, boxes: [{id, text, form?, color?, dash?, weight?, rough?}], links: [[from, to, label?]] or [{from, to, label?, route?, dash?, tail?}], shapes: [{form, x, y, w, h, text, points, color}]}; or flowchart text with --text. Boxes are placed for you, and a link may end on a tile, a frame or anything on the board; `me` is your own tile. --update <drawing> changes a drawing in place. Prints the drawing's id, where it landed, what it overlaps and its `problems`, each with a fix", {
  page: { type: "string", description: "the page or frame it goes inside: its id from `hive ctl page list` or `hive ctl frames`, or top for in no page (default: the frame of what it is drawn beside)" },
  file: { type: "string", description: "read the drawing from this file instead of stdin" },
  text: { type: "string", description: "read flowchart text from this file, or - for stdin: `A[Web app] --> B{Signed in?}: checks`, one statement a line; ((round)), {choice}, -.-> dashed, `direction down`, `image shot <hash>: alt` a picture" },
  image: { type: "string", description: "put this picture on the board (PNG, JPEG, WebP or GIF, at most 10 MB), with --at, --near, --frame or --page; in a drawing's JSON a box { id, image: <file>, alt } is one too" },
  alt: { type: "string", description: "with --image: what the picture shows, in words, for anyone who cannot see it" },
  width: { type: "string", description: "with --image: how wide it is on the board, in pixels (default: its own width, at most 640)" },
  direction: { type: "string", description: "which way the boxes run: right (default) or down" },
  near: { type: "string", description: "draw beside this tile, frame or object (default: beside your own tile)" },
  at: { type: "string", description: "put its top-left corner here on the canvas: x,y" },
  frame: { type: "string", description: "the frame it moves with (default: the frame of what it is drawn beside); none for no frame" },
  update: { type: "string", description: "a drawing's id to update: a box whose key (or id) is there keeps its place and the person's changes, a new one is placed beside what it links to, what you leave out is erased. `hive ctl board --drawing <id> --as text` gives you the text to edit" },
  ...repoArg,
}, (a) => onDrive(async (d) => {
  const at = pointFlag(a.at, "at");
  if (a.direction !== undefined && a.direction !== "right" && a.direction !== "down") throw new UsageError(`--direction must be right or down: ${String(a.direction)}`);
  let flowchart: string | undefined;
  if (a.text !== undefined) {
    try {
      flowchart = fs.readFileSync(a.text === "-" || a.text === "" ? 0 : String(a.text), "utf8");
    } catch (e) {
      throw new UsageError(`cannot read ${a.text === "-" ? "stdin" : String(a.text)}: ${(e as Error).message}`);
    }
  }
  const page = pageFlag(a.page);
  const repo = await workspaceOf(d, a.repo);
  if (a.image === undefined && (a.alt !== undefined || a.width !== undefined)) throw new UsageError("--alt and --width go with --image <file>");
  if (a.image !== undefined && (flowchart !== undefined || a.file !== undefined || a.update !== undefined)) throw new UsageError("--image puts one picture on the board: leave out --text, --file and --update, or name it in a drawing's boxes as { id, image: <file> }");
  let image: BoardImage | undefined;
  let drawing: Record<string, unknown>;
  if (a.image !== undefined) {
    image = await keptImage(d, repo, String(a.image));
    const width = a.width === undefined ? Math.round(image.width * Math.min(1, PLACED_IMAGE_MOST / Math.max(image.width, image.height))) : intFlag(a.width, "width", 8);
    drawing = { boxes: [{ id: "image", image: image.hash, width, ...(a.alt ? { alt: String(a.alt) } : {}) }] };
  } else {
    drawing = flowchart !== undefined ? { text: flowchart } : await imagesKept(d, repo, drawingAsked(a.file));
  }
  const asked = {
    ...drawing,
    ...(a.direction ? { direction: a.direction } : {}),
    ...(a.near ? { near: a.near } : {}), ...(at ? { at } : {}), ...(a.frame ? { frame: a.frame } : {}), ...(a.update ? { update: a.update } : {}),
    ...(page !== undefined ? { page } : {}),
  };
  const drawn = await d.call("board.draw", [repo, asked as never]) as { problems?: Array<{ say: string; fix: string }>; boxes: Record<string, string> };
  if (!a.json) printProblems(drawn.problems ?? []);
  if (!image) return { result: drawn };
  return { result: { ...drawn, image }, line: `put picture ${drawn.boxes.image} on the board: ${image.width}×${image.height}, ${image.hash}` };
}));

/** A board change as a line: its seq, who made it, and what it changed. */
const changeLine = (c: BoardChange): string => `${c.seq}\t${c.by}${c.who ? ` ${c.who}` : ""}\t${c.objects ? c.objects.join(",") : "anything"}`;

/** The board's changes after `since`; following, each as it comes until Ctrl+C. */
async function boardChanges(d: Drive, repo: string, since: number | null, follow: boolean, json: boolean): Promise<Said> {
  if (!follow) {
    const r = await d.call("board.changes", [repo, since]) as BoardChanges;
    const lines = [...(r.lost ? ["some changes are no longer kept: read the board again"] : []), ...r.changes.map(changeLine), ...(r.erased.length ? [`not on the board now: ${r.erased.join(", ")}`] : [])];
    return { result: r, line: [...lines, `seq ${r.seq}: ask again with --since ${r.seq}`].join("\n") };
  }
  // Heard from before the first answer, so nothing that happens meanwhile is missed.
  const heard: BoardChange[] = [];
  let show = (c: BoardChange): void => { heard.push(c); };
  d.on("board.changed", (at, c) => { if (at === repo) show(c as BoardChange); });
  const first = await d.call("board.changes", [repo, since, true]) as BoardChanges;
  let seq = since ?? first.seq;
  show = (c) => {
    if (c.seq <= seq) return;
    seq = c.seq;
    console.log(json ? JSON.stringify(c) : changeLine(c));
  };
  if (first.lost) console.error("some changes are no longer kept: read the board again");
  for (const c of [...first.changes, ...heard]) show(c);
  process.on("SIGINT", () => { d.close(); process.exit(0); });
  await d.closed;
  throw new HcpCliError("UNAVAILABLE", "the app or host stopped", EXIT.unavailable);
}

/** How each change verb reads in the line it prints. */
const CHANGED_SAYS: Readonly<Record<string, string>> = {
  move: "moved", style: "styled", lock: "locked", unlock: "unlocked", front: "brought to the front", back: "sent to the back", align: "lined up", duplicate: "copied",
};

/** What a change did, as lines: what changed, the copies made, what the person's lock kept. */
function changedLine(verb: string, r: BoardChanged): string {
  const lines = [r.copies?.length ? `${CHANGED_SAYS[verb]}: the copies are ${r.copies.join(", ")}`
    : r.changed.length ? `${CHANGED_SAYS[verb]}: ${r.changed.join(", ")}` : `nothing changed: already ${CHANGED_SAYS[verb]}`];
  if (r.locked.length) lines.push(`left as they were, locked by the person: ${r.locked.join(", ")}`);
  return lines.join("\n");
}

const boardCmd = said("board", "What is on the board, in canvas coordinates: its frames, tiles, drawings and objects; --ids or --drawing say those in full; --svg or --png save a picture to look at; --check says what is wrong with what is drawn; --page reads a page. To change what is drawn: `board move <ids> --to x,y` or `--page <page>`, `board style <ids> --color --dash --weight --rough`, `board connect <from> <to> [--label] [--route]`, `board lock|unlock|front|back <ids>`, `board align <ids> --how <how>`, `board duplicate <ids> [--by dx,dy]`; `board undo|redo` takes back or puts back your own last change. `--drawing <id> --as text` prints a drawing as the text `draw --update` takes; `--selected` says what the person has selected in each window; `board changes [--since <seq>] [--follow]` says what changed on the board and who changed it", {
  change: { type: "positional", required: false, description: "move, style, connect, lock, unlock, front, back, align, duplicate, undo, redo or changes; left out: read the board" },
  target: { type: "positional", required: false, description: "shapes or arrows, comma-separated, or a drawing's id for all of it; connect: what the arrow starts on" },
  other: { type: "positional", required: false, description: "connect: what the arrow ends on" },
  page: { type: "string", description: "read, check or picture only what is inside this page or frame, at any depth, by its id from `hive ctl page list` or `hive ctl frames` (default: the whole canvas); move: the page or frame to move them into, or top to take them out of their page" },
  to: { type: "string", description: "move: put its top-left corner here on the canvas, x,y" },
  how: { type: "string", description: "align: left, centre, right, top, middle, bottom, spread-across or spread-down" },
  by: { type: "string", description: "duplicate: how far from the originals the copies go, dx,dy (default 24,24); write a negative one as --by=-24,0" },
  color: { type: "string", description: "style: ink, blue, green, yellow, orange, red or purple" },
  dash: { type: "string", description: "style, connect: solid, dashed or dotted" },
  weight: { type: "string", description: "style: thin, medium or thick" },
  rough: { type: "string", description: "style: yes for the hand-drawn look, no for clean lines" },
  label: { type: "string", description: "connect: what the arrow says" },
  route: { type: "string", description: "connect: straight, elbow or curve" },
  check: { type: "boolean", description: "what is wrong with what is drawn (inside --page when given), each with a fix: exit 0 when nothing is, 10 when something is" },
  ids: { type: "string", description: "these objects in full, comma-separated" },
  drawing: { type: "string", description: "this drawing's objects in full, or the only thing in the picture" },
  limit: { type: "string", description: "how many objects an overview lists (default 200)" },
  svg: { type: "string", description: "save a picture of what is drawn to this file, as SVG" },
  png: { type: "string", description: "save a picture of what is drawn to this file, as PNG: needs the app, not `hive host`" },
  theme: { type: "string", description: "the picture's colours: dark (default) or light" },
  show: { type: "string", description: "bring this drawing or object into view in the app" },
  as: { type: "string", description: "with --drawing: text, to print it as the flowchart text `hive ctl draw --update <drawing> --text -` takes" },
  selected: { type: "boolean", description: "what the person has selected now, in each window showing the workspace" },
  since: { type: "string", description: "changes: only those after this seq, from an earlier answer (left out: none yet, and the seq to ask after)" },
  follow: { type: "boolean", description: "changes: keep going, printing each change as it comes (one JSON per line with --json), until Ctrl+C" },
  ...repoArg,
}, (a) => onDrive(async (d): Promise<Said> => {
  const repo = await workspaceOf(d, a.repo);
  const page = pageFlag(a.page);
  if (a.change === "changes") {
    if (a.target) throw new UsageError("board changes takes no ids: --since <seq> and --follow say which");
    return boardChanges(d, repo, a.since === undefined ? null : intFlag(a.since, "since", 0), !!a.follow, !!a.json);
  }
  if (a.change !== undefined) {
    const verb = String(a.change);
    const target = a.target ? String(a.target) : "";
    if (page !== undefined && verb !== "move") throw new UsageError(`--page goes with move, or with reading the board: board ${verb} acts on its ids wherever they are`);
    if (verb === "undo" || verb === "redo") {
      if (target) throw new UsageError(`board ${verb} takes no ids: it ${verb === "undo" ? "takes back" : "puts back"} your own last change to the board`);
      if (verb === "undo") {
        const r = await d.call("board.undo", [repo]) as { undone: boolean };
        if (!r.undone) throw new HcpCliError("NOTHING_TO_UNDO", "nothing you changed on this board is left to undo", EXIT.refused, "undo takes back only what you changed through `hive ctl` since the app started, newest first; the person's own changes are theirs to undo");
        return { result: r, line: "undid your last change to the board" };
      }
      const r = await d.call("board.redo", [repo]) as { redone: boolean };
      if (!r.redone) throw new HcpCliError("NOTHING_TO_REDO", "nothing you undid on this board is left to redo", EXIT.refused, "redo puts back what `hive ctl board undo` took back, until you change something else");
      return { result: r, line: "put back what you undid" };
    }
    if (verb === "connect") {
      if (!target || !a.other) throw new UsageError("say both ends: hive ctl board connect <from> <to>");
      const link = {
        from: target, to: String(a.other),
        ...(a.label ? { label: String(a.label) } : {}), ...(a.route ? { route: String(a.route) } : {}), ...(a.dash ? { dash: String(a.dash) } : {}),
      };
      const drawn = await d.call("board.draw", [repo, { links: [link] } as never]) as { objects: string[] };
      return { result: drawn, line: `connected ${target} to ${String(a.other)}: ${drawn.objects.join(", ")}` };
    }
    if (!(verb in CHANGED_SAYS)) throw new UsageError(`board takes move, style, connect, lock, unlock, front, back, align, duplicate, undo, redo or changes: ${verb}`);
    const ids = target.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) throw new UsageError(`say what to ${verb}: ids from \`hive ctl board\`, or a drawing's id`);
    let ask: Omit<BoardChangeAsk, "ids">;
    if (verb === "move") {
      const to = pointFlag(a.to, "to");
      if (!to && page === undefined) throw new UsageError("say where: --to x,y on the canvas, or --page <page> to move them into a page or frame");
      ask = { ...(to ? { to } : {}), ...(page !== undefined ? { page } : {}) };
    } else if (verb === "style") {
      if (a.rough !== undefined && a.rough !== "yes" && a.rough !== "no") throw new UsageError(`--rough must be yes or no: ${String(a.rough)}`);
      ask = {
        ...(a.color ? { color: String(a.color) } : {}), ...(a.dash ? { dash: String(a.dash) } : {}), ...(a.weight ? { weight: String(a.weight) } : {}),
        ...(a.rough !== undefined ? { rough: a.rough === "yes" } : {}),
      } as Omit<BoardChangeAsk, "ids">;
    } else if (verb === "align") {
      if (!a.how) throw new UsageError("say how: --how left, centre, right, top, middle, bottom, spread-across or spread-down");
      ask = { align: String(a.how) as AlignHow };
    } else if (verb === "duplicate") {
      const [dx, dy, more] = a.by === undefined ? [24, 24] : String(a.by).split(",").map(Number);
      if (more !== undefined || !Number.isFinite(dx) || !Number.isFinite(dy)) throw new UsageError(`--by must be dx,dy: how far from the originals the copies go: ${String(a.by)}`);
      ask = { duplicate: { dx: dx!, dy: dy! } };
    } else {
      ask = verb === "lock" || verb === "unlock" ? { locked: verb === "lock" } : { stack: verb as "front" | "back" };
    }
    const r = await d.call("board.change", [repo, { ids, ...ask }] as never) as BoardChanged;
    return { result: r, line: changedLine(verb, r) };
  }
  const onPage = page !== undefined ? { page } : {};
  if (a.check) {
    const { problems = [] } = await d.call("board.read", [repo, { check: true, limit: 0, ...onPage } as never]) as { problems?: Array<{ say: string; fix: string }> };
    if (!a.json) printProblems(problems);
    return problems.length > 0
      ? { result: { problems }, line: `${problems.length} problem${problems.length === 1 ? "" : "s"}: fix them, then check again`, exit: EXIT.problems }
      : { result: { problems }, line: "nothing wrong with what is drawn" };
  }
  if (a.selected) {
    const r = await d.call("board.selected", [repo]) as BoardSelection;
    const lines = r.windows.map((w) => `${w.name || w.person} (${w.window}): ${w.selected.length ? w.selected.map((i) => `${i.id} ${i.kind}${i.text ? ` "${i.text}"` : ""}`).join(", ") : "nothing selected"}`);
    return { result: r, line: lines.join("\n") || "no window shows this workspace now" };
  }
  if (a.as !== undefined) {
    if (a.as !== "text") throw new UsageError(`--as takes text: ${String(a.as)}`);
    if (!a.drawing) throw new UsageError("say which drawing: --drawing <id> --as text");
    const r = await d.call("board.read", [repo, { drawing: String(a.drawing), as: "text", limit: 0 }]) as BoardReading;
    return { result: { drawing: String(a.drawing), text: r.text }, line: r.text!.trimEnd() };
  }
  if (a.show) {
    await d.call("board.show", [repo, String(a.show)]);
    return { result: { shown: String(a.show) }, line: `showed ${String(a.show)} in the app` };
  }
  if (a.svg || a.png) {
    const ask = { ...(a.drawing ? { drawing: String(a.drawing) } : {}), ...(a.theme === "light" ? { theme: "light" as const } : {}), ...onPage };
    const file = String(a.png || a.svg);
    const pic = await d.call("board.picture", [repo, a.png ? { ...ask, png: true } : ask]) as BoardPicture;
    fs.writeFileSync(file, "png" in pic ? Buffer.from(pic.png, "base64") : pic.svg);
    const saved = { file: path.resolve(file), width: pic.width, height: pic.height };
    return { result: saved, line: `saved ${saved.file}, ${pic.width}×${pic.height}` };
  }
  return { result: await d.call("board.read", [repo, {
    ...(a.ids ? { ids: String(a.ids).split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(a.drawing ? { drawing: String(a.drawing) } : {}),
    ...(a.limit !== undefined ? { limit: intFlag(a.limit, "limit", 0) } : {}),
    ...onPage,
  }]) };
}));

const erase = said("erase", "Erase what is drawn on the board: by id, a whole drawing, or all this agent drew (--mine). An arrow goes with what it ends on", {
  ids: { type: "positional", required: false, description: "shapes or arrows, comma-separated" },
  drawing: { type: "string", description: "every shape and arrow of this drawing" },
  mine: { type: "boolean", description: "everything this agent drew" },
  by: { type: "string", description: "everything the agent of this tile drew" },
  page: { type: "string", description: "only what is inside this page or frame, at any depth: its id from `hive ctl page list` or `hive ctl frames` (default: anywhere)" },
  ...repoArg,
}, (a) => onDrive(async (d): Promise<Said> => {
  const ids = a.ids ? String(a.ids).split(",").map((s) => s.trim()).filter(Boolean) : [];
  const page = pageFlag(a.page);
  const r = await d.call("board.erase", [await workspaceOf(d, a.repo), {
    ...(ids.length ? { ids } : {}), ...(a.drawing ? { drawing: String(a.drawing) } : {}),
    ...(a.mine ? { by: "me" } : a.by ? { by: String(a.by) } : {}),
    ...(page !== undefined ? { page } : {}),
  }]) as { erased: string[]; locked?: string[] };
  return { result: r, line: [`erased ${r.erased.length}: ${r.erased.join(", ")}`, ...(r.locked?.length ? [`left as they were, locked by the person: ${r.locked.join(", ")}`] : [])].join("\n") };
}));

const pageList = said("list", "Every page in the workspace: its id, title, the page it is inside, and how much is drawn and open inside it, at any depth", { ...repoArg }, (a) => onDrive(async (d): Promise<Said> => {
  const r = await d.call("page.list", [await workspaceOf(d, a.repo)]) as { pages: PageListing[] };
  const line = r.pages.map((p) => `${p.id}\t${p.title}\tin ${p.parent ?? "top"}\t${p.objects} drawn, ${p.tiles} tile${p.tiles === 1 ? "" : "s"}`).join("\n");
  return { result: r, line: line || "no pages: `hive ctl page new \"Title\"` makes one" };
}));

const pageNew = said("new", "Make a page: a frame on the canvas that is a stop on the path while you are inside it. Prints its id", {
  title: { type: "positional", required: true, description: "what the page is called" },
  in: { type: "string", description: "the page or frame it goes inside, by its id, or top (default: the canvas itself)" },
  at: { type: "string", description: "its top-left corner on the canvas, x,y (default: a free spot)" },
  ...repoArg,
}, (a) => onDrive(async (d): Promise<Said> => {
  const at = pointFlag(a.at, "at");
  const inside = pageFlag(a.in);
  const r = await d.call("page.new", [await workspaceOf(d, a.repo), { title: String(a.title), ...(inside ? { in: inside } : {}), ...(at ? { at } : {}) }]) as { id: string };
  return { result: r, line: `made page ${r.id}${inside ? ` inside ${inside}` : ""}: draw in it with --page ${r.id}, go inside it with \`hive ctl page open ${r.id}\`` };
}));

const pageOpen = said("open", "The app's window flies to a page or frame and goes inside it: what is outside dims. top goes back out to the whole canvas", {
  page: { type: "positional", required: true, description: "the page's or frame's id from `hive ctl page list` or `hive ctl frames`, or top" },
  ...repoArg,
}, (a) => onDrive(async (d): Promise<Said> => {
  const page = pageFlag(a.page) ?? null;
  await d.call("page.open", [await workspaceOf(d, a.repo), page]);
  return { result: { opened: page }, line: page ? `the window is inside ${page}` : "the window shows the whole canvas" };
}));

const pageCmd = defineCommand({
  meta: { name: "page", description: "Pages: frames on the one canvas that are stops on the path while you are inside them, nested as deep as you like. List them, make one, go inside one in the app" },
  subCommands: { list: pageList, new: pageNew, open: pageOpen },
});

const pin = said("pin", "Pin a note on the board for the person, on something there or at a place: point at what you mean. `hive ctl notes` lists and answers it", {
  body: { type: "positional", required: true, description: "what it says" },
  on: { type: "string", description: "the tile, frame or object it is pinned to, which it follows" },
  at: { type: "string", description: "where: x,y from that one's corner, else on the canvas" },
  ...repoArg,
}, (a) => onDrive(async (d): Promise<Said> => {
  const at = pointFlag(a.at, "at");
  return { result: await d.call("board.note", [await workspaceOf(d, a.repo), { body: String(a.body), ...(a.on ? { on: String(a.on) } : {}), ...(at ? { at } : {}) }]) };
}));

const tile = defineCommand({
  meta: { name: "tile", description: "Look at a tile as the person sees it" },
  subCommands: { look: tileLook },
});

const plugin = defineCommand({
  meta: { name: "plugin", description: "Drive the plugins in the app: list what runs, open one, list and call their commands, close one" },
  subCommands: { list: pluginList, open: pluginOpen, commands: pluginCommands, call: pluginCall, close: pluginClose },
});

export const ctlCmd = defineCommand({
  meta: { name: "ctl", description: "Drive the running hivemind app (spawn/send/read/stream/workflow/report) and the issue verbs agents use" },
  subCommands: {
    whoami, agents, tiles, frames, frame, draw, board: boardCmd, erase, page: pageCmd, pin, "open-tool": openTool, spawn, sessions, send, keys, read, stream, workflow, approve, approval, report, inbox, ask, post, follow, unfollow, channels: channelsCmd, claim, release, claims, "open-review": openReview,
    focus, open, close, sleep, wake, rename, connect, disconnect, view, plugin, tile,
    "send-file": sendFile, "sent-files": sentFilesCmd, "take-back-file": takeBackFile,
    "set-state": setState, "add-comment": addComment, "mark-acceptance": markAcceptance,
    "delete-issue": deleteIssueCmd, "list-workspaces": listWorkspacesCmd, notes: notesCmd, browser,
    code: codeCommand({ sub, onDrive, workspaceOf, repoArg }),
  },
});
