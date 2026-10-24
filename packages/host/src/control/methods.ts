/**
 * What the control plane does. Two callers:
 *   - the agent channel on hcp.sock (`agentChannel`): what an agent's plugin and hooks say from
 *     its own tile — its reply, a report to its starter, a tool use its starter approves, a plan
 *     a person reviews. Each is recorded here.
 *   - the workspace API (`api`, asked by control-api.ts): sending, keys, reading, naming, tools,
 *     pipes, and the machine's own methods. The API records each effect, as its caller's; a
 *     window's work (view.emit, plugin.*, tile.focus, rescans) goes to `deps.callRenderer`.
 */
import fs from "node:fs";
import path from "node:path";
import { speaksFor } from "@hivemind/agent-host/hooks/token";
import { typeKeys } from "@hivemind/agent-host/keys";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { LOOK_MS, PLUGIN_CALL_HOST_MS, PLUGIN_CALL_MS, type PluginList, type TileLook } from "@hivemind/workspace-api/plugins";
import type { HcpCall } from "./protocol.js";
import type { TurnTracker } from "./turn-tracker.js";
import type { OutputRecorder } from "./output-recorder.js";
import type { Inbox } from "./inbox.js";
import { mintId, toPtyId as ptyId, toBareId as bareOf } from "@hivemind/workspace-api/tile-id";
import type { AgentItem, AgentRead, AgentSessions, SleepAnswer, Skipped, TileOpened, WakeAnswer } from "@hivemind/workspace-api/agents";
import { labelOf as labelIn } from "./names.js";
import { agentById, agentForCmd, agentLaunch, agentOption, cleanName, isSessionId, nextOrdinal, spawnableAgents, workerAgents, type AgentProviderDef, type AgentStatus, type InputKind, type SpawnOptions } from "@hivemind/agents";
import { hookAnswerOf, hookAsks, printedAnswer, toolAbout, type HookReply } from "@hivemind/agents/node";
import { canListSessions, listSessions } from "@hivemind/agents/node";
import { BUNDLED_TOOL_PLUGINS } from "@hivemind/core/tool-plugins";
import { createToolRegistry, type ToolPluginContribution } from "@hivemind/core/tool-registry";
import type { ToolsSettings } from "@hivemind/core/settings-schema";
import { customDataProblem, isCustomEventName } from "@hivemind/view-sdk/protocol";
import { COMMAND_NAME_RE } from "@hivemind/view-sdk/commands";
import { NothingAsleep } from "@hivemind/agent-host/pty-protocol";
import { AGENT_TILE_KIND, isTerminalKind, type KeptCore, type FrameRecord, type TileRecord } from "@hivemind/workspace-doc/shapes";
import { defaultFrame, frameFor } from "@hivemind/workspace-doc/tile-list";
import type { WorkspaceStore } from "@hivemind/workspace-host/store";
import type { Waits } from "../waits.js";
import { folderOf } from "../needs.js";
import { Refused, type Intent, type Intents } from "@hivemind/workspace-host/intents";
import type { StatusStore } from "@hivemind/agent-host/status-store";
import type { SpawnRecords } from "./spawn-records.js";

/** `view.emit` rate: a steady 10 per second, bursts of 30. */
export const EMIT_RATE = { perSecond: 10, burst: 30 };

/** Validate a `view.emit` from `caller` (an agent's tile, else the shell); throws BAD_REQUEST with the reason. */
export function parseEmit(name: unknown, rawData: unknown, view: unknown, caller?: string): { name: string; data: unknown; view?: string; from: "shell" | { tileId: string } } {
  if (!isCustomEventName(name)) throw new ApiError("BAD_REQUEST", "name must be dotted lowercase words (a-z, 0-9, -), at most 64 characters, not under hive. or hm.");
  const data = rawData === undefined ? null : rawData;
  const problem = customDataProblem(data);
  if (problem) throw new ApiError("BAD_REQUEST", problem);
  if (view != null && (typeof view !== "string" || view.length === 0 || view.length > 256)) throw new ApiError("BAD_REQUEST", "view must be a view id");
  return { name, data, ...(view ? { view: view as string } : {}), from: caller ? { tileId: caller } : "shell" };
}

/** A token bucket: `take()` is false once the burst is spent until it refills. */
export function tokenBucket(rate: { perSecond: number; burst: number }, now: () => number = () => Date.now()) {
  let tokens = rate.burst;
  let last = now();
  return {
    take(): boolean {
      const t = now();
      tokens = Math.min(rate.burst, tokens + ((t - last) / 1000) * rate.perSecond);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/** Max agent-spawn depth (user = 0). Bounds recursive agent-spawns-agent fan-out
 *  alongside the rate cap — the review flagged this gate as specified-but-unenforced. */
const MAX_SPAWN_DEPTH = 3;

/** Default brokered tools when `supervise` is on but unspecified — the mutating /
 *  external ones worth a supervisor's eyes; safe reads pass through untouched. */
const DEFAULT_BROKER_TOOLS = "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch";

/** A supervisor has up to this long to answer before the worker falls back to its
 *  own (human) permission prompt. < the hook's command timeout. */
/** How long the supervisor has to ANSWER, measured from when the request actually
 *  reached its terminal (not from when the worker asked — it may have been held
 *  while the supervisor was mid-turn). */
const APPROVAL_TIMEOUT_MS = 9 * 60 * 1000;
/** Hard ceiling on the whole wait, so a supervisor that never comes back to its
 *  prompt can't hang the worker (and leak the pending entry) forever. */
const APPROVAL_MAX_WAIT_MS = 20 * 60 * 1000;

/** Whether a provider can be supervised is declared in its catalog def
 *  (`caps.supervise`). A runtime with no permission system of its own has
 *  nothing to broker: there is no native prompt for a broker to intercept or to
 *  fail back to, so any gate we injected must fail closed and would brick the
 *  worker on the first hiccup. A `supervise` request for it is refused at
 *  spawn, not silently downgraded — a caller that thinks it has a gate but
 *  doesn't is worse off than one that knows it has none. */
function superviseUnsupported(agent: string): boolean {
  return agentById(agent)?.caps.supervise === "none";
}

/** Normalize a `supervise` arg into the HIVE_SUPERVISE env string (a tool list or
 *  "all"), or null to disable. */
function normalizeSupervise(s: unknown): string | null {
  if (s === true || s === "parent" || s === "default" || s === "on") return DEFAULT_BROKER_TOOLS;
  if (s === "all" || s === "*") return "all";
  if (Array.isArray(s)) { const j = s.map(String).map((x) => x.trim()).filter(Boolean).join(","); return j || null; }
  if (typeof s === "string" && s.trim()) return s.trim();
  return null;
}

/** A short human-readable summary of a tool call for the approval prompt. */
function summarizeTool(tool: string, inp: Record<string, unknown>): string {
  if (tool === "Bash" && typeof inp.command === "string") return inp.command.slice(0, 300);
  if (typeof inp.file_path === "string") return inp.file_path;
  if (typeof inp.url === "string") return inp.url;
  try { return JSON.stringify(inp).slice(0, 200); } catch { return "(unprintable input)"; }
}

/** A box in a window's page, in CSS pixels. */
export interface TileRect { x: number; y: number; width: number; height: number }

export interface MethodDeps {
  /** Settled main-process tool preferences; absent means no optional tools enabled. */
  toolsSettings?: (installed: readonly ToolPluginContribution[]) => ToolsSettings;
  /** The tool plugins added on this machine that can load (none in safe mode). */
  addedTools?: () => Promise<readonly ToolPluginContribution[]>;
  /** Provider id of a (user-spawned) tile, from its command — for the
   *  capability check on read. Optional: HCP-spawned tiles are
   *  tracked internally. */
  agentOf?: (bareTileId: string) => string | undefined;
  /** Run a renderer verb (returns its result); rejects/throws ApiError on
   *  no-renderer / timeout. */
  callRenderer: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  /** Tool plugins' services that answer commands (`plugin-services.ts`): a plugin call that no
   *  window runs is answered there, under `hive host` too. */
  services?: { call(plugin: string, command: string, args: unknown, ms: number): Promise<unknown> | null; commands(): Array<{ plugin: string; commands: unknown[] }> };
  /** A picture of the window `callRenderer` reaches, of `rect` in its page's CSS pixels; absent
   *  where no window shows tiles (a headless host). */
  captureWindow?: (rect: TileRect) => Promise<{ png: string; width: number; height: number }>;
  /** Re-read settings.json (edited by the CLI) and broadcast it. */
  reloadSettings: () => Promise<unknown>;
  /** Re-list the installed widgets (`hive plugins install|remove`) and tell every window. */
  widgetsChanged?: () => void;
  /** Re-list the installed tool plugins (`hive plugins install|remove`) and tell every window. */
  toolsChanged?: () => void;
  /** Write to a tile's pty RIGHT NOW. Returns false if the tile has no live pty.
   *  Raw bytes only (key sequences) — for anything the agent must READ, use
   *  `deliverToTile`, which waits for it to be at its prompt. */
  writeToTile: (tileId: string, data: string) => boolean;
  /** Deliver a MESSAGE to an agent (typed + Enter), holding it until that agent is
   *  back at its prompt. A message typed into a mid-turn TUI lands in the composer
   *  unsubmitted and is never read — see hcp/mailbox.ts. `onSent` fires when the
   *  text actually reaches the terminal (which is when an approval's answer-clock
   *  should start). `photos`: the paths of photos given with it, which its agent is handed as its
   *  manifest says it takes them. Returns false only if the tile's pty is dead. */
  deliverToTile: (ptyId: string, text: string, onSent?: () => void, photos?: string[]) => boolean;
  /** What other agents have for an agent (by bare id), until it reads them. */
  inbox: Pick<Inbox, "post" | "wait" | "given" | "forget">;
  /** A tile's session was put to sleep: its turn is over. Its exit says so too, when something here
   *  was attached to it; twice is the same as once. */
  slept(bare: string): void;
  /** A tile's session was woken: what waited for it is told once it is up (`ready`, at the latest). */
  woke(bare: string, ready?: Promise<void>): void;
  /** What the agent of a tile waits on, as the person's devices are told it. */
  waitingOf: (bareTile: string) => AgentItem["waiting"];
  turns: TurnTracker;
  recorder: OutputRecorder;
  /** Sliding-window spawn gate (reuse the ptySpawn rate-limit). false → refuse. */
  /** Whether `by` (the top of a tree of agents: a tile, `client:<grant id>`, or "person") may
   *  start one more now. */
  spawnAllowed: (by: string) => boolean;
  /** The agent a spawn with no `agent` starts (the user's default, if installed).
   *  Undefined when no agent is installed. May wait: at boot the PATH the answer
   *  depends on is still being read. */
  defaultAgentId?: () => string | undefined | Promise<string | undefined>;
  /** The agent's CLI is where it would run: the caller's remote host, else the machine of the
   *  folder it runs in (a path here, or a remote uri; none: here). Absent = assume it is. */
  agentInstalled?: (def: AgentProviderDef, where: { callerTile?: string; folder?: string }) => boolean | Promise<boolean>;
  /** Pipe src's finished-turn replies into dst's input. Returns false on a bad
   *  pair (e.g. src === dst). */
  connect: (srcTileId: string, dstTileId: string) => boolean;
  /** Remove a pipe (or all of src's pipes when dst is omitted). */
  disconnect: (srcTileId: string, dstTileId?: string) => void;
  /** Drop a tile from the pipe graph entirely (both directions) on close. */
  forgetPipes: (tileId: string) => void;
  /** Record/drop the spawn-parentage link (parent → child). ALWAYS
   *  set on spawn, independent of the report/data pipe. Call with parent=null,
   *  connected=false to drop every spawn link touching `child` (on close). */
  spawnEdge: (child: string, parent: string | null, connected: boolean) => void;
  /** Who started each spawned tile and on what terms, kept across restarts. Main injects a
   *  worker's supervision as HIVE_SUPERVISE into its spawn env, so the daemon installs the
   *  permission-broker hook. */
  spawnRecords: SpawnRecords;
  /** What agents wait on that an answer ends: a supervised worker's tool use, a plan. */
  waits: Waits;
  /** The workspaces main has open. The canvas verbs read them, and write them as `control`;
   *  their windows follow. */
  workspaces: Pick<WorkspaceStore, "workspaceOf" | "getCore" | "setCore" | "addTile" | "setView" | "renameTile" | "removeTile" | "repos" | "ownership" | "setSleeping">;
  /** The workspace the window the user is at shows, and the frame the user is in there, if
   *  any: what a caller in no tile (a terminal, a script) acts on. */
  shownWorkspace: () => { repo: string; frame: string | null } | null;
  /** The launch options the user saved for an agent. */
  launchOptions: (agentId: string) => SpawnOptions;
  /** Tell the windows about a tile the control plane is opening, before it reaches the layout
   *  (whether to bring it forward), and start it with `prompt`. */
  announceSpawn: (spawn: TileOpened & { prompt?: string }) => void;
  /** Every session's status, as its host reports it. */
  status: Pick<StatusStore, "get">;
  /** End the session a tile runs (by its pty id), as its window's kill does; `folder`, where one
   *  asleep sleeps. */
  endSession: (ptyId: string, folder?: string) => void;
  /** End the process of the session a tile runs in `folder` (by its pty id), keeping it to be
   *  woken. Rejects with why it cannot. */
  sleepSession: (ptyId: string, folder: string) => Promise<void>;
  /** Wake the session a tile runs (by its pty id) where it sleeps, its agent resumed, and keep it
   *  running whoever shows it. `pid` -1: no answer in time; `ready` settles once its agent is at its
   *  prompt. Rejects with why it cannot. */
  wakeSession: (start: { ptyId: string; cwd: string; cmd: string; args: string[] }) => Promise<{ pid: number; ready?: Promise<void> }>;
  /** The conversation the agent of a tile (bare id) keeps, as this machine knows it; undefined
   *  when it knows none. */
  sessionOf?: (bareTile: string) => string | undefined;
  /** Whether main holds a session by this pty id (a window showed it, here or remote). */
  sessionHeld: (ptyId: string) => boolean;
  /** Ask the host an invite link names to let this person in, as the Join dialog does. */
  join?: (link: string) => Promise<unknown>;
  /** Carries out every verb with an effect, and records it in the audit log (R7). */
  intents: Pick<Intents, "perform">;
  /** A worker a program started reported `message` to it. */
  reported?: (tile: string, message: string) => void;
}

/** A parent that is a program on the drive socket, not an agent's tile. */
const isClient = (parent: string): boolean => parent.startsWith("client:");
/** Who opens a tile, by the tile or program that asks: none is the person. */
const openedBy = (asker?: string): TileOpened["by"] => (!asker ? "person" : isClient(asker) ? "program" : "agent");

/** How the control plane writes a workspace: its windows hear of it, and it hears of none. */
const CONTROL = { writer: "control" };

/** The most a tile's state opened with it may hold, as JSON. */
const TILE_STATE_MAX = 64 * 1024;
const RENDERER_TIMEOUT = 15_000;
const DEFAULT_READ_TIMEOUT = 120_000;
/** The longest a timer waits (about 24.8 days): a longer one fires at once. */
const LONGEST_WAIT_MS = 2 ** 31 - 1;
/** How much of what an agent printed `agent.output` gives when not asked for more. */
const DEFAULT_OUTPUT_LINES = 40;
const REVIEW_TIMEOUT = 24 * 60 * 60 * 1000; // human review may take a long time
const MAX_INBOX_WAIT_MS = 10 * 60 * 1000;

/** The control plane's part of the workspace API (control-api.ts), its params checked there.
 *  None records itself: the API records each effect, as its caller's. `caller`: the agent's
 *  tile that asks (bare); none for the person or a program. */
export interface ControlWork {
  /** Hand `text` to the agent of `tile` as its next prompt, held while it is in a turn unless it
   *  reads one there; the read that follows waits for the turn it causes. `sent` false: no agent
   *  runs there; `held`: it waits for the turn to end. */
  send(tile: string, text: string, photos?: string[]): { sent: boolean; held: boolean };
  /** Type `keys` into the terminal of `tile`, one by one: how many. */
  keys(tile: string, keys: string[]): number;
  /** The reply of the turn after the last prompt sent to `tile`, waiting up to `timeoutMs`. */
  read(tile: string, timeoutMs?: number): Promise<AgentRead>;
  /** The last `lines` of what the agent of `tile` printed. */
  output(tile: string, lines?: number): { text: string };
  /** Name `tile`: the name it took. */
  rename(tile: string, name: string): string;
  sessions(program: string, cwd: string, limit?: number): Promise<AgentSessions>;
  /** Open the tool `tool` in the workspace at `repo`: its tile. */
  openTool(caller: string | undefined, repo: string, tool: string, at: { frame?: unknown; url?: unknown; state?: unknown }): Promise<string>;
  connect(src: string, dst: string): void;
  disconnect(src: string, dst?: string): void;
  viewEmit(caller: string | undefined, name: unknown, data: unknown, view: unknown): Promise<unknown>;
  pluginList(): Promise<PluginList>;
  pluginCommands(): Promise<unknown>;
  pluginOpen(caller: string | undefined, plugin: unknown, frame: unknown): Promise<unknown>;
  pluginCall(plugin: unknown, command: unknown, args: unknown, tile: unknown): Promise<unknown>;
  pluginClose(instance: string, plugin: string | undefined): Promise<{ closed: string; plugin: string; kind: string }>;
  focus(tile: string): Promise<unknown>;
  look(tile: string): Promise<TileLook>;
  rescan(what: "views" | "agents" | "widgets" | "tools"): Promise<unknown>;
  reloadSettings(): Promise<unknown>;
  hostStatus(): { workspaces: Array<{ repo: string; workspace: string | null }> };
  /** Put to sleep the agents of `target` in the workspace of `repo` (a tile or a frame, by id or
   *  name; none: all of them), leaving one working or waiting on someone unless `force`. */
  sleep(repo: string, target: string | undefined, force: boolean, caller?: string): Promise<SleepAnswer>;
  /** Wake the sleeping agents of `target` in the workspace of `repo` (none: all of them). */
  wake(repo: string, target: string | undefined): Promise<WakeAnswer>;
  join(link: string): Promise<unknown>;
  /** Serve the folder `folder` on this machine as one of its workspaces (`hive host add`), as the
   *  app's own Open folder does, with no window: a layout of its own in the store, and so an id. */
  serve(folder: string): { repo: string; workspace: string };
}

export interface Dispatcher {
  /** One call on the agent channel (hcp.sock), made by `call.actor`. */
  agentChannel: (method: string, params: unknown, call: HcpCall) => Promise<unknown>;
  api: ControlWork;
  /** The session of a tile ended (crash, exit, restart): what waits on it is answered now, and
   *  what was kept for that session goes. Its parent, its workers and its pipes stay. Idempotent. */
  sessionEnded: (tileId: string) => void;
  /** The tile is gone for good (closed): everything above, and its pipes, spawn wires and parent
   *  records. Idempotent. */
  forgetTile: (tileId: string) => void;
  /** What the control plane's messages call a tile (names.ts). */
  labelOf: (tileId: string) => string;
  /** The tile asleep in a conversation that `args`, started in `tile`, would resume. */
  conversationAsleep: (tile: string, args: readonly string[]) => string | undefined;
  /** A tile's session was put to sleep: a read waiting on its turn is answered so. */
  asleep: (tileId: string) => void;
  /** Spawn an agent, without recording it: the caller has (M5). */
  spawn: (opts: {
    agent?: string; frame?: string; prompt?: string; model?: string; mode?: string; name?: string; resume?: string;
    supervise?: string | true; report?: boolean; parent?: string; repo: string;
  }) => Promise<string>;
  /** Who started `bare` and hears its reports: a tile, or a program (`client:<grant id>`). */
  parentOf: (bare: string) => string | undefined;
  /** Close a tile, without recording it: the caller has (M5). */
  close: (tileId: string) => Promise<unknown>;
  /** A tile's status changed. A spawned worker that starts waiting on input is reported
   *  to the agent that spawned it, once per wait. */
  onStatus: (tileId: string, status: Pick<AgentStatus, "state" | "kind">) => void;
}

/** What a worker is waiting for, as its parent is told. */
const WAITING_FOR: Record<InputKind, string> = {
  permission: "permission to go on",
  question: "an answer to its question",
  plan: "its plan to be reviewed",
  approval: "your approval",
  other: "input",
};

export function makeDispatch(deps: MethodDeps): Dispatcher {
  // Per-tile read epoch: set at spawn/send so agent.read waits for the turn that
  // FOLLOWS the prompt we just delivered (not a stale earlier turn).
  const sendSeq = new Map<string, number>();
  const emitBucket = tokenBucket(EMIT_RATE);
  const callBucket = tokenBucket(EMIT_RATE);
  const sendMark = new Map<string, number>();
  // The tiles sent something since their last reply was read: a read of any other waits only
  // while it works, since nothing new will come.
  const sentSinceRead = new Set<string>();

  // Bare↔pty id mapping lives in @hivemind/workspace-api/tile-id (imported as ptyId/bareOf). The
  // pty, recorder, turn-tracker and HIVEMIND_TILE are keyed by the pty id; the
  // control surface uses the bare id.

  // Who started a spawned tile (agent.report and approvals go there), its spawn depth (a tile
  // the person opened is 0, enforced against MAX_SPAWN_DEPTH) and its agent (a tile the person
  // opened is resolved by deps.agentOf from its command).
  const parentOf = (bare: string): string | undefined => deps.spawnRecords.get(bare)?.parent;
  const providerOf = (tileId: string): string | undefined => deps.spawnRecords.get(bareOf(tileId))?.agent ?? deps.agentOf?.(bareOf(tileId));
  /** Refuse a verb that needs a deterministic turn signal from a provider that
   *  has none — an honest UNSUPPORTED instead of a read that times out. */
  const requireTurnSignal = (tileId: string, verb: string): void => {
    const id = providerOf(tileId);
    const def = id ? agentById(id) : undefined;
    if (def && !def.caps.turnSignal) {
      throw new ApiError("UNSUPPORTED", `${verb}: ${def.id} has no turn signal (${def.note ?? "scrape-only status"}) — drive it by hand or use a worker runtime: ${workerAgents().map((d) => d.id).join(", ")}`);
    }
  };
  // Agent-supervised approvals (HCP Phase 6). A supervised worker's PreToolUse broker hook calls
  // `agent.await_approval`, which waits (`deps.waits`) until its starter answers.

  const armRead = (tileId: string) => {
    const pid = ptyId(tileId);
    sendSeq.set(pid, deps.turns.currentSeq(pid));
    sendMark.set(pid, deps.recorder.mark(pid));
    sentSinceRead.add(pid);
  };

  // A message the mailbox is still HOLDING (the agent is mid-turn). Its read epoch
  // can only be armed once it is actually typed — armed at enqueue time, the next
  // agent.read returns the turn already in flight, i.e. the PREVIOUS prompt's reply.
  // A read that arrives while one is pending waits for the delivery first.
  const pendingSend = new Map<string, Promise<void>>();
  const holdUntilSent = (pid: string): (() => void) => {
    let done!: () => void;
    const p = new Promise<void>((r) => { done = r; });
    pendingSend.set(pid, p);
    return () => { if (pendingSend.get(pid) === p) pendingSend.delete(pid); done(); };
  };

  // Who answers for a start, and so whose limit it uses: the top of the tree of agents it is
  // started from (a program, an agent the person started, or the person), so a tree shares one.
  const rootOf = (caller: string | undefined): string => {
    let at = caller;
    for (let i = 0; at && !isClient(at) && i <= MAX_SPAWN_DEPTH; i++) {
      const up = deps.spawnRecords.get(at)?.parent;
      if (!up) break;
      at = up;
    }
    return at ?? "person";
  };

  // Spawn one child tile and wire up its bookkeeping (depth, parent, auto-report,
  // supervision, read epoch), behind the depth/rate gates. Throws ApiError on depth/rate/spawn
  // failure. `report` defaults to on (pipes the child's reports to the parent);
  // a worker whose reply is read instead (a workflow's) passes report:false.
  const doSpawn = async (opts: {
    agent?: unknown; prompt?: unknown; frame?: unknown; mode?: unknown; model?: unknown;
    report?: unknown; supervise?: unknown; name?: unknown; resume?: unknown;
    /** Who starts it: an agent's tile (bare), or a program on the drive socket (`client:<grant id>`). It
     *  reports, and asks its approvals, to that one. */
    parent?: string;
    /** The workspace to open it in (a person's spawn from another of their devices, M5), not the
     *  caller's or the one the user's window shows. */
    repo?: string;
  }): Promise<string> => {
    // An agent that starts one is its tile: the child is a level below it, beside it on the board.
    const tile = opts.parent && !isClient(opts.parent) ? opts.parent : undefined;
    const callerDepth = tile ? (deps.spawnRecords.get(tile)?.depth ?? 0) : 0;
    const childDepth = callerDepth + 1;
    if (childDepth > MAX_SPAWN_DEPTH) {
      throw new ApiError("DEPTH_EXCEEDED", `agent spawn depth ${childDepth} exceeds max ${MAX_SPAWN_DEPTH}`);
    }
    const agent = opts.agent != null ? String(opts.agent) : await deps.defaultAgentId?.();
    // Nothing compiled in to fall back to: an empty catalog means no agent can start.
    if (!agent) throw new ApiError("BAD_REQUEST", "no agent installed — install one from Settings ▸ Plugins");
    const def = agentById(agent);
    if (!def || !def.enabled) {
      throw new ApiError("BAD_REQUEST", `unknown agent '${agent}' — spawnable: ${spawnableAgents().map((d) => d.id).join(", ")}`);
    }
    const place = placeTile(tile, opts.frame, opts.repo);
    const folder = place.frame?.worktreePath ?? place.frame?.workspacePath ?? undefined;
    if (deps.agentInstalled && !(await deps.agentInstalled(def, { ...(tile ? { callerTile: ptyId(tile) } : {}), ...(folder ? { folder } : {}) }))) {
      throw new ApiError("UNSUPPORTED", `${def.label} is not installed on this machine (no ${def.bin} on PATH)${def.install ? ` — get it at ${def.install.url}` : ""}`);
    }
    const sup = normalizeSupervise(opts.supervise);
    // Supervision is brokered TO the caller's tile. Without one there is nobody to ask,
    // and the policy would be dropped silently while the caller believes it has a gate.
    if (sup && !opts.parent) {
      throw new ApiError("BAD_REQUEST", "supervise needs a supervising agent: run this from an agent tile, or spawn without --supervise");
    }
    // pi cannot be supervised. It has NO permission system, so the only gate would be
    // one we inject — which must fail CLOSED (no human prompt to fall back to) and
    // therefore bricks the worker on any hiccup. Refuse LOUDLY rather than spawning
    // an ungated worker the caller believes it is supervising: a false gate is worse
    // than no gate. (A user-opened pi tile is fully autonomous too — this changes
    // nothing about pi's actual authority.)
    if (sup && superviseUnsupported(agent)) {
      throw new ApiError(
        "BAD_REQUEST",
        `${agent} workers cannot be supervised — ${agent} has no permission system, so there is nothing to broker. ` +
          `Spawn this worker WITHOUT supervise (it runs autonomously, like any ${agent} tile), ` +
          `or spawn a claude worker with supervise if you need to gate its tools.`,
      );
    }
    // No human at the tile of an agent's worker, so it runs in its agent's unattended mode —
    // unless the caller chose one, or it is supervised (its broker hook only fires while
    // permissions are not skipped). One the person or a program starts keeps its prompts.
    const mode = opts.mode != null ? opts.mode : sup || !tile ? undefined : agentOption(def, "mode")?.unattended;
    const resume = opts.resume != null ? String(opts.resume) : undefined;
    if (resume !== undefined) {
      if (!def.session?.resume) throw new ApiError("UNSUPPORTED", `${def.label} cannot resume a session`);
      if (!isSessionId(resume)) throw new ApiError("BAD_REQUEST", "resume must be a session id");
      // Woken later, it would write the same conversation as this one.
      const holder = sleeperIn(resume);
      if (holder) throw new ApiError("FAILED", `that conversation is asleep in tile ${holder.id}: wake it instead`);
    }
    // A spawner-chosen display name ("reviewer", "test-writer") — becomes the tile
    // name and tags every message this worker sends back. One printable line, capped like every
    // name, so a worker can't smuggle a paragraph (or ANSI) into the parent's terminal banner.
    const name = typeof opts.name === "string" ? cleanName(opts.name) : "";
    const prompt = typeof opts.prompt === "string" && opts.prompt ? opts.prompt : undefined;
    // The user's saved options for this agent, with this launch's own on top.
    const options: SpawnOptions = { ...deps.launchOptions(def.id) };
    if (mode) options.mode = String(mode);
    if (opts.model) options.model = String(opts.model);
    if (!deps.spawnAllowed(rootOf(opts.parent))) throw new ApiError("RATE_LIMITED", "spawn rate limit exceeded");
    // `background` = a silent worker (report:false → gathered in bulk, e.g. a workflow worker):
    // its window does not bring it forward, and does not announce each one finishing.
    const tileId = openTile(place, (ws) => ({
      id: mintId(`tile-${def.id}`), kind: AGENT_TILE_KIND,
      ...agentLaunch(def, { options, labels: ws.tiles.map((t) => t.label), prompt, resume }),
    }), { name, prompt, background: opts.report === false, by: openedBy(opts.parent) });
    const res = { tileId };
    const spawner = tile && tile !== res.tileId ? tile : undefined;
    deps.spawnRecords.add(res.tileId, {
      agent, depth: childDepth, reports: !!spawner && opts.report !== false,
      ...(opts.parent ? { parent: opts.parent } : {}),
      ...(spawner ? { spawner } : {}),
      ...(opts.parent && sup ? { supervise: sup } : {}),
    });
    if (spawner) {
      // Parentage is recorded for sub-agents AND background workflow workers
      // (report:false); the report pipe is separate and only for report:true.
      deps.spawnEdge(res.tileId, spawner, true);
      if (opts.report !== false) deps.connect(res.tileId, spawner);
    }
    armRead(res.tileId);
    return res.tileId;
  };

  // Workers whose current wait their parent has been told about.
  const waitTold = new Set<string>();
  // The `hive ctl read`s waiting on each tile, told when it stops to wait on an answer, its agent
  // exits or it is put to sleep instead.
  const readers = new Map<string, Set<(state: "waiting" | "exited" | "asleep") => void>>();

  // What a session's end drops: its turns, its sends, its waits and its inbox. Wakes anything
  // blocked on it (readers via turns.forget → seq -1; approvals resolved "worker closed") so a
  // crash doesn't hang a parent for the full timeout. Its links to other tiles stay: a restart is
  // not a removal. Idempotent: every op is a delete/forget that no-ops when already gone.
  const forgetSessionState = (tileId: string): void => {
    const pid = ptyId(tileId);
    const bare = bareOf(tileId);
    deps.turns.forget(pid);
    deps.recorder.forget(pid);
    sendSeq.delete(pid);
    sendMark.delete(pid);
    sentSinceRead.delete(pid);
    pendingSend.delete(pid);
    deps.waits.forget(bare);
    waitTold.delete(bare);
    deps.inbox.forget(bare);
  };

  // A tile gone for good: its session's state, and its pipes, spawn wires and parent records.
  const forgetTileState = (tileId: string): void => {
    const bare = bareOf(tileId);
    forgetSessionState(tileId);
    deps.forgetPipes(bare);
    deps.spawnEdge(bare, null, false); // drop spawn wires where this tile is parent OR child
    deps.spawnRecords.forget(bare);
  };

  /** What `bare` waits on, said to the agent that started it, while it still waits on that. */
  const waitingNotice = (bare: string, since: number) => (): string | null => {
    const now = deps.status.get(bare);
    if (now?.state !== "waiting" || now.since !== since) return null;
    const on = deps.waitingOf(bare);
    const asks = (on?.asks ?? []).map((a) => `\n  ${a.question}${a.options.map((o, i) => `\n    ${i + 1}. ${o}`).join("")}`).join("");
    return `${label(bare)} is waiting for ${WAITING_FOR[on?.kind ?? now.kind ?? "other"]}.${asks}\n` +
      `See it: hive ctl stream ${bare} --lines 40 --snapshot · answer: hive ctl keys ${bare} Down,Enter or hive ctl send ${bare} "…"`;
  };

  const onStatus: Dispatcher["onStatus"] = (tileId, status) => {
    const bare = bareOf(tileId);
    if (status.state === "exited") for (const told of readers.get(bare) ?? []) told("exited");
    if (status.state !== "waiting") { waitTold.delete(bare); return; }
    // A `hive ctl read` waiting on it is told; then the one that started it need not be.
    const reading = readers.get(bare);
    if (reading?.size) { for (const told of reading) told("waiting"); return; }
    // An approval is the parent's own question: its message went out already.
    if (status.kind === "approval" || waitTold.has(bare)) return;
    const parent = parentOf(bare);
    // A program that started it reads its status itself.
    if (!parent || isClient(parent)) return;
    waitTold.add(bare);
    const since = deps.status.get(bare)?.since ?? 0;
    deps.inbox.post(parent, { from: bare, name: label(bare), kind: "waiting", text: waitingNotice(bare, since) });
  };

  // Close a tile, with no window needed: it leaves its workspace and the session it runs ends, but
  // not one it adopted (`hive run`, another device), which is someone else's job and keeps running.
  // Then its state here goes.
  const closeTile = async (tileId: string): Promise<unknown> => {
    const closed = deps.workspaces.removeTile(bareOf(tileId), CONTROL)?.tile;
    if (!closed) throw new ApiError("NOT_FOUND", `no open workspace has tile ${bareOf(tileId)}`);
    if (isTerminalKind(closed.kind) && !closed.session) deps.endSession(ptyId(tileId), closed.sleeping);
    sleepers.delete(closed.id);
    forgetTileState(tileId);
    return { ok: true };
  };

  // ── Sleep and wake (docs/design/sleep-agents-2026-10-17.md) ──
  /** The tile `bare` as its workspace holds it; undefined when none does. */
  const recordOf = (bare: string): TileRecord | undefined => {
    const repo = deps.workspaces.workspaceOf(bare);
    return repo === null ? undefined : coreOf(repo).tiles.find((t) => t.id === bare);
  };
  /** Every tile asleep, in every workspace here. */
  const asleep = (): TileRecord[] => deps.workspaces.repos().flatMap((repo) => coreOf(repo).tiles.filter((t) => !!t.sleeping));
  /** The tile other than `except` asleep in the conversation `session`: started again elsewhere, it
   *  would be written by two processes once that tile wakes. */
  const sleeperIn = (session: string, except?: string): TileRecord | undefined =>
    asleep().find((t) => t.id !== except && sleepsIn(t.id) === session);
  /** The conversation each sleeper is in, read once: nothing runs to change it while it sleeps. */
  const sleepers = new Map<string, string | undefined>();
  const sleepsIn = (bare: string): string | undefined => {
    if (!sleepers.has(bare)) sleepers.set(bare, deps.sessionOf?.(bare));
    return sleepers.get(bare);
  };
  /** The tile each conversation is being woken in, while that wake is in flight. */
  const wakingIn = new Map<string, string>();
  /** The tile asleep in a conversation that `args`, started in `tile`, would resume. */
  const conversationAsleep = (tile: string, args: readonly string[]): string | undefined =>
    args.map((a) => a.slice(a.indexOf("=") + 1)).filter(isSessionId).map((s) => sleeperIn(s, bareOf(tile))).find(Boolean)?.id;
  /** The work on each tile's sleep or wake, the latest last: a wake waits for a sleep in flight. */
  const sleepWork = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(bare: string, work: () => Promise<T>): Promise<T> => {
    const run = (sleepWork.get(bare) ?? Promise.resolve()).catch(() => {}).then(work);
    const settled = run.catch(() => {});
    sleepWork.set(bare, settled);
    void settled.then(() => { if (sleepWork.get(bare) === settled) sleepWork.delete(bare); });
    return run;
  };
  /** The tiles of `target` in the workspace of `repo`: a tile by its id or name, else those of a
   *  frame (and the frames in it) by its id or name; none: all of them. */
  const tilesOf = (repo: string, target: string | undefined): { core: KeptCore; tiles: readonly TileRecord[] } => {
    if (!deps.workspaces.repos().includes(repo)) throw new ApiError("NOT_FOUND", "no such workspace here");
    const core = coreOf(repo);
    if (!target) return { core, tiles: core.tiles };
    const byId = core.tiles.find((t) => t.id === bareOf(target));
    if (byId) return { core, tiles: [byId] };
    const named = core.tiles.filter((t) => core.tileNames?.[t.id] === target);
    if (named.length > 1) throw new ApiError("BAD_REQUEST", `${named.length} tiles are called "${target}": name one by its id`);
    if (named.length === 1) return { core, tiles: named };
    const frame = frameFor(core.frames, target);
    if (!frame) throw new ApiError("NOT_FOUND", `no tile or frame here answers to "${target}"`);
    const within = new Set([frame.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of core.frames) if (f.parentFrameId && within.has(f.parentFrameId) && !within.has(f.id)) { within.add(f.id); grew = true; }
    }
    return { core, tiles: core.tiles.filter((t) => within.has(core.frameOf?.[t.id] ?? "")) };
  };
  const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  /** Why `tile` is not put to sleep; null when it is. */
  const keptAwake = (tile: TileRecord, force: boolean): string | null => {
    if (tile.session) return "it shows a session started elsewhere, which is theirs";
    const def = agentForCmd(tile.cmd);
    if (!def) return "not an agent: only an agent comes back where it was";
    if (!def.session?.resume) return `${def.label} cannot resume its conversation: it would wake blank`;
    const state = deps.status.get(tile.id)?.state;
    if (!force && (state === "working" || state === "waiting")) return `${state}: --force puts it to sleep anyway`;
    return null;
  };
  const sleepTiles = async (repo: string, target: string | undefined, force: boolean, caller?: string): Promise<SleepAnswer> => {
    const { core, tiles } = tilesOf(repo, target);
    const slept: string[] = [];
    const skipped: Skipped[] = [];
    await Promise.all(tiles.filter((t) => isTerminalKind(t.kind)).map(async (tile) => {
      // Asked to put every agent to sleep, an agent does not put itself to sleep: it names itself.
      if (!target && caller && tile.id === bareOf(caller)) return void skipped.push({ tile: tile.id, why: "it is the one asking: name it to put it to sleep" });
      if (tile.sleeping) return void skipped.push({ tile: tile.id, why: "asleep already", already: true });
      const kept = keptAwake(tile, force);
      if (kept) return void skipped.push({ tile: tile.id, why: kept });
      const folder = folderOf({ repo, core }, tile.id);
      try {
        await oneAtATime(tile.id, async () => {
          // Given up on is not undone: asked again, the daemon answers once the first is done.
          await deps.sleepSession(ptyId(tile.id), folder).catch(() => deps.sleepSession(ptyId(tile.id), folder));
          deps.workspaces.setSleeping(tile.id, folder, CONTROL);
          deps.slept(tile.id);
          // Asleep, what it said before is done with: a read after the wake waits for what comes next.
          sendSeq.set(ptyId(tile.id), deps.turns.currentSeq(ptyId(tile.id)));
          sentSinceRead.delete(ptyId(tile.id));
        });
        slept.push(tile.id);
      } catch (e) {
        skipped.push({ tile: tile.id, why: why(e) });
      }
    }));
    return { slept, skipped };
  };
  const wakeTiles = async (repo: string, target: string | undefined): Promise<WakeAnswer> => {
    const { core, tiles } = tilesOf(repo, target);
    const woke: string[] = [];
    const skipped: Skipped[] = [];
    // A tile named is woken whatever its layout says (its daemon knows); a frame's, those asleep or
    // going to sleep.
    const named = tiles.length === 1 && !!target && tiles[0]!.id === bareOf(target);
    await Promise.all(tiles.filter((t) => isTerminalKind(t.kind) && (t.sleeping || named || sleepWork.has(t.id))).map(async (tile) => {
      const def = agentForCmd(tile.cmd);
      if (!def) return void skipped.push({ tile: tile.id, why: `no agent here runs ${tile.cmd ?? "it"}` });
      if (!tile.cmd) return void skipped.push({ tile: tile.id, why: "it runs nothing" });
      const start = { ptyId: ptyId(tile.id), cwd: tile.sleeping ?? folderOf({ repo, core }, tile.id), cmd: tile.cmd, args: (tile as TileRecord & { args?: string[] }).args ?? [] };
      // Another tile running this conversation, or waking it now, would write it as this one does.
      const session = deps.sessionOf?.(tile.id);
      const claimed = session ? wakingIn.get(session) : undefined;
      const twin = claimed && claimed !== tile.id
        ? claimed
        : session ? core.tiles.find((t) => t.id !== tile.id && !t.sleeping && deps.sessionOf?.(t.id) === session && deps.sessionHeld(ptyId(t.id)))?.id : undefined;
      if (twin) return void skipped.push({ tile: tile.id, why: `tile ${twin} runs this conversation now` });
      if (session) wakingIn.set(session, tile.id);
      try {
        const { pid } = await oneAtATime(tile.id, async () => {
          // A sleep it waited for may have left it awake; one named that runs is awake already.
          if (!recordOf(tile.id)?.sleeping && (!named || deps.sessionHeld(ptyId(tile.id)))) return { pid: 0 };
          // No answer in time is asked again: a wake of what runs now joins it.
          let r = await deps.wakeSession(start);
          if (r.pid === -1) r = await deps.wakeSession(start);
          if (r.pid !== -1) {
            deps.workspaces.setSleeping(tile.id, null, CONTROL);
            sleepers.delete(tile.id);
            deps.woke(tile.id, r.ready);
          }
          return r;
        });
        if (pid === 0) skipped.push({ tile: tile.id, why: "awake already", already: true });
        else if (pid === -1) skipped.push({ tile: tile.id, why: "no answer from where it sleeps" });
        else woke.push(tile.id);
      } catch (e) {
        // Kept asleep, it could never be woken: shown again, it starts afresh.
        if (e instanceof NothingAsleep && tile.sleeping) {
          deps.workspaces.setSleeping(tile.id, null, CONTROL);
          sleepers.delete(tile.id);
          return void skipped.push({ tile: tile.id, why: "what it saved is gone: shown again, it starts afresh" });
        }
        skipped.push({ tile: tile.id, why: why(e) });
      } finally {
        if (session && wakingIn.get(session) === tile.id) wakingIn.delete(session);
      }
    }));
    return { woke, skipped };
  };

  // The workspace a canvas verb acts on: the one holding the caller's tile, else the one the
  // user's window shows (with the frame the user is in there); null with neither.
  const workspaceFor = (callerTile: unknown): { repo: string; core: KeptCore; frame: string | null } | null => {
    const held = typeof callerTile === "string" && callerTile ? deps.workspaces.workspaceOf(bareOf(callerTile)) : null;
    const shown = deps.shownWorkspace();
    const repo = held ?? shown?.repo ?? null;
    if (repo === null) return null;
    return { repo, core: coreOf(repo), frame: shown?.repo === repo ? shown.frame : null };
  };
  // A workspace the store holds whose window has not laid it out yet is open, with nothing in it.
  const coreOf = (repo: string): KeptCore => deps.workspaces.getCore(repo) ?? { frames: [], tiles: [] };

  // Where the control plane opens a tile: the workspace and frame (the one named, else beside the
  // caller, else the one the user is in, else the first; none in a workspace with no frames, where
  // the window that lays it out makes one).
  type Place = { ws: { repo: string; core: KeptCore; frame: string | null }; frame: FrameRecord | undefined; caller: string | undefined };
  const placeTile = (callerTile: unknown, named: unknown, repo: string | undefined): Place => {
    const ws = repo === undefined ? workspaceFor(callerTile)
      : deps.workspaces.repos().includes(repo) ? { repo, core: coreOf(repo), frame: null } : null;
    if (!ws) throw new ApiError("NOT_FOUND", "no workspace is open: open one in the app first");
    let frame: FrameRecord | undefined;
    const caller = typeof callerTile === "string" && callerTile ? bareOf(callerTile) : undefined;
    if (named != null && named !== "") {
      frame = frameFor(ws.core.frames, String(named));
      if (!frame) throw new ApiError("NOT_FOUND", `no frame answers to "${String(named)}"`);
    } else {
      frame = defaultFrame(ws.core.frames, { caller: caller && ws.core.frameOf?.[caller], selected: ws.frame });
    }
    return { ws, frame, caller };
  };
  // Open the tile there, and tell the windows so.
  const openTile = (
    { ws, frame, caller }: Place, make: (ws: KeptCore) => TileRecord, at: { name?: string; prompt?: string; background: boolean; by: TileOpened["by"] },
  ): string => {
    const tile = make(ws.core);
    const near = caller && frame && ws.core.frameOf?.[caller] === frame.id ? caller : undefined;
    deps.announceSpawn({ tileId: tile.id, repo: ws.repo, prompt: at.prompt, background: at.background, by: at.by, ...(near ? { near } : {}) });
    deps.workspaces.addTile(ws.repo, tile, { frame: frame?.id, name: at.name }, CONTROL);
    return tile.id;
  };

  /** Open a tool plugin's tile: the tool `pick` chooses among the registered ones. */
  type RegisteredTool = ReturnType<typeof createToolRegistry>["tools"][number];
  /** The tools there are: the app's own and those added here; the app's own alone if those clash. */
  async function toolRegistry() {
    const added = await deps.addedTools?.() ?? [];
    let registry: ReturnType<typeof createToolRegistry>;
    try { registry = createToolRegistry([...BUNDLED_TOOL_PLUGINS, ...added]); } catch { registry = createToolRegistry(BUNDLED_TOOL_PLUGINS); }
    return { registry, preferences: deps.toolsSettings?.(added) ?? { enabledPlugins: [], disabledTools: [] } };
  }
  async function openTool(at: { caller?: string; repo?: string; frame?: unknown; url?: unknown; state?: unknown }, pick: (tools: RegisteredTool[]) => RegisteredTool | undefined, badId: string): Promise<string> {
    const { registry, preferences } = await toolRegistry();
    const tool = pick(registry.tools.filter((t) => t.tileKind));
    if (!tool?.tileKind) throw new ApiError("UNSUPPORTED", `${badId}; \`hive plugins list --kind tool\` shows them`);
    const availability = registry.resolve(preferences).availability(tool.id);
    if (!availability.available) throw new ApiError("FORBIDDEN", `${tool.label} is disabled; switch it on in Settings ▸ Plugins, or \`hive plugins enable tool:${tool.pluginId}\``);
    const kind = tool.tileKind;
    if (at.frame != null && (typeof at.frame !== "string" || !at.frame || at.frame.length > 256)) throw new ApiError("BAD_REQUEST", "frame must be an id");
    if (at.url != null) {
      if (typeof at.url !== "string" || at.url.length > 8192) throw new ApiError("BAD_REQUEST", "Invalid URL");
      let url: URL;
      try { url = new URL(at.url); } catch { throw new ApiError("BAD_REQUEST", "Invalid URL"); }
      if (!["http:", "https:"].includes(url.protocol) && at.url !== "about:blank") throw new ApiError("BAD_REQUEST", "URL must use http or https, or be about:blank");
    }
    if (at.state != null) {
      let size = Infinity;
      try { size = JSON.stringify(at.state).length; } catch { /* not JSON */ }
      if (typeof at.state !== "object" || Array.isArray(at.state) || size > TILE_STATE_MAX) throw new ApiError("BAD_REQUEST", `state must be a JSON object of at most ${TILE_STATE_MAX} bytes, its keys what the tool's useTileState reads`);
    }
    const place = placeTile(at.caller, at.frame, at.repo);
    // One of a kind per frame: the tile there is brought forward, crashed or not, instead of another piling up.
    const open = tool.singleton ? place.ws.core.tiles.find((t) => t.kind === kind && place.ws.core.frameOf?.[t.id] === place.frame?.id) : undefined;
    if (open) {
      await deps.callRenderer("tile.focus", { tileId: open.id }, RENDERER_TIMEOUT).catch(() => {});
      return open.id;
    }
    if (!deps.spawnAllowed(rootOf(at.caller))) throw new ApiError("RATE_LIMITED", "spawn rate limit exceeded");
    const url = typeof at.url === "string" ? at.url : undefined;
    const id = mintId(`tile-${kind.replace(/[^A-Za-z0-9-]/g, "")}`);
    // Kept before the tile is there, so its first draw reads it (`hm.hello.layout`).
    if (at.state != null) deps.workspaces.setView(place.ws.repo, `tile:${id}`, { v: 1, data: at.state }, CONTROL);
    return openTile(place, (ws) => ({
      id, kind,
      label: `${tool.label} #${nextOrdinal(ws.tiles.map((t) => t.label), (n) => `${tool.label} #${n}`)}`,
      ...(url ? { url } : {}),
    }), { background: false, by: openedBy(at.caller) });
  }

  const label = (tileId: string): string => labelIn(tileId, deps.workspaces, deps.status);

  // What the agent channel carries out is checked against the policy and recorded through the
  // intents. (The workspace API records its own.)
  const effect = <R>(call: HcpCall, intent: Intent<R>, run: () => Promise<R>): Promise<R> =>
    deps.intents.perform(call.actor, intent, run).catch((e: unknown) => {
      throw e instanceof Refused ? new ApiError("FORBIDDEN", e.message) : e;
    });
  const tileOf = (id: unknown): string | undefined => (typeof id === "string" && id ? bareOf(id) : undefined);

  const agentChannel = async (method: string, rawParams: unknown, call: HcpCall): Promise<unknown> => {
    let p = (rawParams ?? {}) as Record<string, unknown>;
    // A tile speaks for itself: the caller a call names is the tile its token names. Naming
    // another is refused (and recorded); a call that names none is its tile's all the same. A
    // person may act for any tile.
    if (call.actor.kind === "tile") {
      const named = tileOf(p.callerTile);
      if (named && !speaksFor(call.actor, named)) return effect(call, { verb: method, target: named, onlyBy: named }, async () => undefined);
      if (!named) p = { ...p, callerTile: ptyId(call.actor.tile) }; // as `hive ctl` names it: $HIVEMIND_TILE
    }
    switch (method) {
      case "agent.report":
        return effect(call, { verb: method, target: (r) => r.parent }, async () => {
          // A spawned worker pushes a result back to the agent that spawned it: kept in that
          // agent's inbox. The caller is its OWN tile (HIVEMIND_TILE).
          const child = bareOf(String(p.callerTile ?? ""));
          const parent = parentOf(child);
          if (!parent) throw new ApiError("NOT_FOUND", "no parent agent to report to");
          const message = String(p.message ?? "").trim();
          if (!message) throw new ApiError("BAD_REQUEST", "message required");
          // A program that started it hears it as an event of the agent feed.
          if (isClient(parent)) {
            deps.reported?.(child, message);
            deps.turns.markReported(ptyId(child));
            return { delivered: true, parent };
          }
          deps.inbox.post(parent, { from: child, name: label(child), kind: "report", text: message });
          // Its own summary stands for this turn: the turn's reply is not sent as well.
          deps.turns.markReported(ptyId(child));
          // A starter asleep keeps it in its inbox, told of it once it is woken.
          if (recordOf(parent)?.sleeping) return { delivered: true, parent, asleep: true, note: `delivered to ${parent}'s inbox; it is asleep and reads it when woken` };
          return { delivered: true, parent };
        });

      case "agent.inbox": {
        // What other agents have for the calling agent, oldest first, read now; waiting up to
        // `wait` ms for the first when none has come.
        const tile = tileOf(p.callerTile);
        if (!tile) throw new ApiError("BAD_REQUEST", "an inbox is an agent's: run this in its tile, or pass --tile");
        const ms = typeof p.wait === "number" && Number.isFinite(p.wait) ? Math.min(Math.max(0, p.wait), MAX_INBOX_WAIT_MS) : 0;
        return deps.inbox.wait(tile, ms);
      }

      case "agent.reply": {
        // The agent's plugin hands over this turn's reply before it reports the turn end.
        const tileId = String(p.tileId ?? "");
        const text = typeof p.text === "string" ? p.text : "";
        if (!tileId || !text) throw new ApiError("BAD_REQUEST", "tileId and text required");
        // A tile hands over its own reply, never another's.
        if (!speaksFor(call.actor, tileId)) return effect(call, { verb: method, target: bareOf(tileId), onlyBy: bareOf(tileId) }, async () => undefined);
        deps.turns.recordReply(ptyId(tileId), text);
        return { ok: true };
      }

      case "agent.await_approval": {
        // Called by a SUPERVISED worker's PreToolUse broker hook before a tool
        // runs. Decided already when its starter answered `always` for the tool, else ask the
        // starter and BLOCK (a wait) until `agent.answer` or the timeout.
        const worker = bareOf(String(p.callerTile ?? ""));
        const tool = String(p.tool_name ?? "");
        if (!worker || !tool) return { decision: "ask" };
        const ruled = deps.waits.ruled(worker, tool);
        if (ruled) return { decision: ruled };
        const parent = parentOf(worker);
        if (!parent) return { decision: "ask" }; // no supervisor → fall back to human prompt
        // Asking is the effect: the question is typed into the supervisor's terminal, and the
        // worker waits for the answer.
        return effect(call, { verb: method, target: parent, detail: tool.slice(0, 128) }, async () => {
          const summary = summarizeTool(tool, (p.tool_input ?? {}) as Record<string, unknown>);
          return await new Promise((resolve) => {
            let timer: ReturnType<typeof setTimeout>;
            // The worker waits on its starter; an answer is the decision its hook gets.
            // No answer: "ask" (claude: its own prompt; pi: blocks).
            const wait = deps.waits.ask(worker, { kind: "approval", tool, summary, input: p.tool_input, expiresAt: Date.now() + APPROVAL_MAX_WAIT_MS, answerer: parent }, (decision, reason) => {
              clearTimeout(timer);
              resolve(decision ? { decision, ...(reason ? { reason } : {}) } : { decision: "ask" });
            });
            const unanswered = () => deps.waits.drop(wait.request);
            // Two clocks, never both live. Until the question is DELIVERED only the ceiling runs,
            // so a starter that never returns to its prompt (dead, wedged) cannot hang the worker.
            // On delivery the answer clock replaces it: it starts when the starter SEES the
            // question, which may have been held minutes while it was mid-turn.
            timer = setTimeout(unanswered, APPROVAL_MAX_WAIT_MS);
            timer.unref?.();
            // A hook that stopped waiting (it gave up and asked the agent's own prompt) has no use
            // for an answer: the wait ends with it, and an answer after that is told so.
            if (call.signal?.aborted) return unanswered();
            call.signal?.addEventListener("abort", unanswered, { once: true });
            const armAnswerTimeout = () => {
              if (!deps.waits.named(wait.request)) return;
              clearTimeout(timer);
              timer = setTimeout(unanswered, APPROVAL_TIMEOUT_MS);
              timer.unref?.();
              deps.waits.expires(wait.request, Date.now() + APPROVAL_TIMEOUT_MS);
            };
            // A program reads the wait in the agent feed, its answer clock running from now.
            if (isClient(parent)) return armAnswerTimeout();
            const asks =
              `${label(worker)} wants to run ${tool}: ${summary}\n` +
              `Answer: hive ctl approve ${wait.request} allow|deny|always|never  (allow = this call; always = this tool, for this worker)`;
            const posted = { from: worker, name: label(worker), kind: "approval" as const, text: () => (deps.waits.named(wait.request) ? asks : null) };
            // Its answer clock starts when the supervisor reads it.
            if (!deps.inbox.post(parent, posted, armAnswerTimeout)) unanswered(); // parent's pty is gone
          });
        });
      }

      case "agent.await_answer": {
        // The agent's own hook holds what it asks for the answer (`agent.answer`) while the agent
        // waits on it; printing nothing leaves it to the agent's own prompt. A subagent's is its own.
        const tile = tileOf(p.callerTile);
        const def = tile ? agentById(providerOf(tile)) : undefined;
        const answer = def ? hookAnswerOf(def, String(p.hook ?? "")) : undefined;
        const tool = typeof p.tool === "string" ? p.tool : "";
        if (!tile || !answer || p.agentId != null || answer.leave?.includes(tool)) return {};
        const asks = hookAsks(answer, p.input);
        // Its session file records the use only once it has run: what it is about is the hook's.
        const transcript = def?.session?.transcript;
        const about = transcript && tool ? toolAbout(transcript, tool, p.input) : undefined;
        return await new Promise((resolve) => {
          const wait = deps.waits.hold(tile, { tool, ...(about ? { about } : {}), ...(asks ? { asks } : {}), chooses: !!answer.choose }, (decision, feedback, answers) => {
            if (!decision) return resolve({});
            // A line typed answers each of its questions.
            const reply: HookReply = asks ? { answers: answers ?? asks.map(() => ({ text: feedback ?? "" })) } : { decision, ...(feedback ? { message: feedback } : {}) };
            const stdout = printedAnswer(answer, p.input, reply);
            resolve(stdout ? { stdout } : {});
          });
          if (!wait) return resolve({});
          if (call.signal?.aborted) return deps.waits.drop(wait.request);
          call.signal?.addEventListener("abort", () => deps.waits.drop(wait.request), { once: true });
        });
      }

      case "review.open": {
        // The calling agent waits on a person's review of its plan: a plan wait, answered where
        // every plan is (beside the agent in each window, `agent.answer`). The decision it comes
        // back with is recorded.
        const decided = (r: unknown) => {
          const decision = (r as { decision?: unknown } | null)?.decision;
          return decision === "allow" || decision === "deny" ? decision : undefined;
        };
        return effect(call, { verb: method, detail: decided }, async () => {
          if (!p.plan) throw new ApiError("BAD_REQUEST", "plan required");
          const tile = tileOf(p.callerTile);
          if (!tile) throw new ApiError("BAD_REQUEST", "a plan is reviewed for the agent that wrote it: run this in its tile, or pass --tile");
          return await new Promise((resolve, reject) => {
            let why = "it waits on something else now";
            const wait = deps.waits.ask(tile, { kind: "plan", plan: String(p.plan), cwd: String(p.cwd ?? "") }, (decision, feedback) => {
              clearTimeout(timer);
              if (decision) resolve({ decision, ...(feedback ? { feedback } : {}) });
              else reject(new ApiError("TIMEOUT", `the plan was not reviewed: ${why}`));
            });
            const unanswered = (reason: string) => { why = reason; deps.waits.drop(wait.request); };
            const timer = setTimeout(() => unanswered("nobody reviewed it in time"), REVIEW_TIMEOUT);
            timer.unref?.();
            call.signal?.addEventListener("abort", () => unanswered("the caller stopped waiting"), { once: true });
          });
        });
      }

      default:
        throw new ApiError("UNKNOWN_METHOD", `unknown method: ${method} (the agent channel carries agent.reply, agent.report, agent.inbox, agent.await_approval, agent.await_answer and review.open; drive the rest with \`hive ctl\`)`);
    }
  };

  /** Refused, the same for every verb that needs its agent running: it is asleep. */
  const asleepError = (bare: string): ApiError => new ApiError("ASLEEP", `tile ${bare} is asleep: wake it with hive ctl wake ${bare}`);
  const refuseAsleep = (tile: string): void => {
    if (recordOf(bareOf(tile))?.sleeping) throw asleepError(bareOf(tile));
  };

  // A tile no open workspace holds, running no session main holds, is gone.
  const requireOpen = (tile: string): void => {
    if (deps.workspaces.workspaceOf(bareOf(tile)) === null && !deps.sessionHeld(ptyId(tile))) throw new ApiError("NOT_FOUND", `no tile ${bareOf(tile)} is open: it was closed, or never opened`);
  };

  const api: ControlWork = {
    sleep: sleepTiles,
    wake: wakeTiles,
    send(tile, text, photos) {
      refuseAsleep(tile);
      // Delivered through the mailbox, which types text-then-Enter as separate writes (a bundled
      // newline is dropped by claude's TUI) and HOLDS it while the agent is mid-turn, where it
      // would strand in the composer unread.
      const pid = ptyId(tile);
      const sent = holdUntilSent(pid);
      // Typed in at once, it is sent before deliverToTile returns.
      let typed = false;
      const ok = deps.deliverToTile(pid, text, () => { typed = true; armRead(tile); sent(); }, photos);
      if (!ok) sent();
      return { sent: ok, held: ok && !typed };
    },

    keys(tile, keys) {
      refuseAsleep(tile);
      // Each token maps via KEYMAP (arrows/enter/esc/…) or is sent as literal text, staggered so
      // the TUI registers each key: a bundled arrow+enter write can miss the move.
      const pid = ptyId(tile);
      armRead(tile); // keys can submit a prompt; a following read wants the turn they cause
      if (!typeKeys((bytes) => deps.writeToTile(pid, bytes), keys)) throw new ApiError("NOT_FOUND", `no live agent for tile ${bareOf(tile)}`);
      return keys.length;
    },

    async read(tile, asked = DEFAULT_READ_TIMEOUT) {
      requireTurnSignal(tile, "agent.read");
      const timeoutMs = Math.min(asked, LONGEST_WAIT_MS);
      const pid = ptyId(tile);
      // Say a gone tile is gone now, rather than wait out the timeout for a turn that cannot
      // come. A tile still starting is in its workspace already.
      requireOpen(tile);
      const bare = bareOf(tile);
      const record = recordOf(bare);
      if (record && !providerOf(tile) && (record.kind !== AGENT_TILE_KIND || (record.cmd !== undefined && !agentForCmd(record.cmd)))) {
        throw new ApiError("NO_AGENT", `no agent runs in tile ${bare}, so no reply will come from it`);
      }
      if (record?.sleeping) throw asleepError(bare);
      // A send may still be queued behind the turn in flight; its epoch is armed when
      // it is typed, so wait for that before deciding which turn this read wants.
      // One budget for the whole read: waiting for a held send to be typed must not
      // extend the call past the ceiling the caller (and the CLI) is waiting on.
      const deadline = Date.now() + timeoutMs;
      const pending = pendingSend.get(pid);
      if (pending) await Promise.race([pending, new Promise<void>((r) => { const t = setTimeout(r, timeoutMs); t.unref?.(); })]);
      const afterSeq = sendSeq.get(pid) ?? deps.turns.currentSeq(pid);
      // Sent nothing since its last reply was read, ended no turn since, and not working: nothing
      // will come until it is sent a task.
      const state = deps.status.get(bare)?.state;
      if (!sentSinceRead.has(pid) && deps.turns.currentSeq(pid) <= afterSeq && state !== undefined && !(["working", "waiting", "exited"] as string[]).includes(state)) {
        return { text: null, finalStatus: "idle", truncated: false, note: `nothing new since you last read it: send it a task with hive ctl send ${bare}` };
      }
      // It cannot end its turn while it waits on an answer, or once its agent has exited: say so
      // instead of running out of time. A turn it already ended comes first.
      const stopped = new AbortController();
      const waited = new Promise<"waiting" | "exited" | "asleep">((resolve) => {
        const now = deps.status.get(bare)?.state;
        if (now === "waiting" || now === "exited") return resolve(now);
        const set = readers.get(bare) ?? new Set();
        set.add(resolve);
        readers.set(bare, set);
        stopped.signal.addEventListener("abort", () => set.delete(resolve), { once: true });
      });
      const rec = await Promise.race([deps.turns.waitForTurn(pid, afterSeq, Math.max(0, deadline - Date.now()), stopped.signal), waited]);
      stopped.abort();
      if (rec === "waiting") {
        deps.inbox.given(bare, "waiting");
        const on = deps.waitingOf(bare) ?? { kind: deps.status.get(bare)?.kind ?? "other", since: deps.status.get(bare)?.since ?? 0 };
        return {
          text: null, finalStatus: "waiting", truncated: false, waiting: on,
          note: `waiting for ${WAITING_FOR[on.kind]}: see it with hive ctl stream ${bare} --lines 40 --snapshot, answer with hive ctl keys or hive ctl send`,
        };
      }
      // A tile that died under us is not "still working" — say so, and keep the read's
      // shape so a caller parsing finalStatus does not have to special-case an error.
      if (rec === "exited") return { text: null, finalStatus: "closed", truncated: false, note: "its agent exited: no turn will come" };
      if (rec === "asleep") throw asleepError(bare);
      if (rec && rec.seq === -1) return { text: null, finalStatus: "closed", truncated: false, note: "tile closed while waiting" };
      // Consume this turn: without advancing the epoch the NEXT read returns the same
      // turn instantly, so a poll loop can never tell a new answer from the old one.
      if (rec) {
        sendSeq.set(pid, rec.seq);
        sentSinceRead.delete(pid);
        deps.inbox.given(bare, "reply", rec.seq);
      }
      if (rec && typeof rec.text === "string" && rec.text.length > 0) return { text: rec.text, finalStatus: "turn", truncated: false };
      if (rec) return { text: null, finalStatus: "turn", truncated: false, note: "turn completed but carried no readable reply" };
      // No completed turn within the timeout: the agent is still working. Spawned with
      // report:true, its reply goes to its starter's inbox when done.
      if (timeoutMs === 0) return { text: null, finalStatus: "working", truncated: false, note: `still working: wait for its reply with hive ctl read ${bare}` };
      return { text: null, finalStatus: "timeout", truncated: false, note: "agent still working — no completed turn within timeout" };
    },

    // The tail of what an agent printed, as the recorder holds it.
    output(tile, lines = DEFAULT_OUTPUT_LINES) {
      requireOpen(tile);
      return { text: deps.recorder.tail(ptyId(tile), lines) };
    },

    rename(tile, raw) {
      // The name every surface shows, and the one main's messages call the tile by.
      const name = cleanName(raw);
      if (deps.workspaces.renameTile(bareOf(tile), name, CONTROL) === null) throw new ApiError("NOT_FOUND", `no open workspace has tile ${bareOf(tile)}`);
      return name;
    },

    async sessions(program, cwd, limit) {
      const def = agentById(program);
      if (!def) throw new ApiError("BAD_REQUEST", `unknown agent '${program}'`);
      if (!canListSessions(def)) throw new ApiError("UNSUPPORTED", `${def.label} does not say where its sessions are, so they cannot be listed`);
      const sessions = await listSessions(def, { cwd, ...(limit ? { limit: Math.min(limit, 500) } : {}) });
      return { agent: def.id, resumable: !!def.session?.resume, sessions };
    },

    // A tool's full id, or its package's id when that package has one tool.
    openTool: (caller, repo, tool, at) => openTool({ caller, repo, ...at }, (tools) => {
      const inPackage = tools.filter((t) => t.pluginId === tool);
      if (inPackage.length > 1) throw new ApiError("BAD_REQUEST", `${tool} has ${inPackage.length} tools; name one: ${inPackage.map((t) => t.id).join(", ")}`);
      return tools.find((t) => t.id === tool) ?? inPackage[0];
    }, "Unknown tool id"),

    connect(src, dst) {
      requireOpen(src);
      requireOpen(dst);
      refuseAsleep(src);
      refuseAsleep(dst);
      if (!deps.connect(src, dst)) throw new ApiError("BAD_REQUEST", "cannot pipe a tile to itself or create a cycle");
    },
    disconnect(src, dst) {
      requireOpen(src);
      deps.disconnect(src, dst);
    },

    // A named JSON event for the active view (protocol 1.3).
    async viewEmit(caller, name, data, view) {
      const ev = parseEmit(name, data, view, caller);
      if (!emitBucket.take()) throw new ApiError("RATE_LIMITED", `at most ${EMIT_RATE.perSecond} view events a second`);
      return await deps.callRenderer("view.emit", ev, RENDERER_TIMEOUT);
    },
    // Every plugin running in the window, with its state; and what the ready ones let an agent run.
    pluginList: async () => await deps.callRenderer("plugin.list", {}, RENDERER_TIMEOUT) as PluginList,
    // The services' commands after the window's: none runs in a window under `hive host`.
    async pluginCommands() {
      const served = (deps.services?.commands() ?? []).map(({ plugin, commands }) => ({ plugin, kind: "service", instance: "service", label: `${plugin} (service)`, commands }));
      const inWindow = await deps.callRenderer("plugin.commands", {}, RENDERER_TIMEOUT).catch((e: unknown) => {
        if (served.length && e instanceof ApiError && e.code === "UNAVAILABLE") return { plugins: [] };
        throw e;
      }) as { plugins?: unknown[] };
      return served.length ? { ...inWindow, plugins: [...(inWindow.plugins ?? []), ...served] } : inWindow;
    },
    // Get a plugin running, so its commands can be called: a tool's tile opened (`@owner/name`, its
    // first tool, or `@owner/name/tool`), a widget added to the board, a view switched to. The id
    // alone is enough; `<kind>:` names one where two kinds have it.
    async pluginOpen(caller, plugin, frame) {
      const m = typeof plugin === "string" && plugin && plugin.length <= 200 ? /^(?:(tool|widget|view):)?(.+)$/.exec(plugin) : null;
      if (!m) throw new ApiError("BAD_REQUEST", "plugin must be its id, as `hive plugins list` shows it");
      const [, named, id] = m as unknown as [string, "tool" | "widget" | "view" | undefined, string];
      const pick = (tools: RegisteredTool[]) => tools.find((t) => t.id === id) ?? tools.find((t) => t.pluginId === id);
      if (named === "tool" || (!named && pick((await toolRegistry()).registry.tools.filter((t) => t.tileKind)))) {
        const tile = await openTool({ caller, frame }, pick, `${id} has no tool to open`);
        // Answered once its tile's plugin can be called, as a widget's and a view's are.
        return { tile, ...(await deps.callRenderer("plugin.settle", { instance: tile }, RENDERER_TIMEOUT) as object) };
      }
      const kind = named ?? "any";
      if (kind === "widget" && !deps.spawnAllowed(rootOf(caller))) throw new ApiError("RATE_LIMITED", "spawn rate limit exceeded");
      return await deps.callRenderer("plugin.open", { kind, id }, RENDERER_TIMEOUT);
    },
    // Run one, and answer with what the plugin answered.
    async pluginCall(plugin, command, args, tile) {
      if (typeof plugin !== "string" || !plugin || plugin.length > 200) throw new ApiError("BAD_REQUEST", "plugin must be an id, as `hive ctl plugin commands` lists it");
      if (typeof command !== "string" || !COMMAND_NAME_RE.test(command)) throw new ApiError("BAD_REQUEST", "command must be one of the plugin's command names");
      if (tile != null && (typeof tile !== "string" || !tile || tile.length > 256)) throw new ApiError("BAD_REQUEST", "tile must be an id");
      if (!callBucket.take()) throw new ApiError("RATE_LIMITED", `at most ${EMIT_RATE.perSecond} plugin calls a second`);
      try {
        return await deps.callRenderer("plugin.call", { plugin, command, args: args ?? null, ...(tile ? { tile } : {}) }, PLUGIN_CALL_HOST_MS);
      } catch (e) {
        // No window runs it (or none is open): its service, when it answers that command. A call
        // for one tile is that tile's.
        const served = !tile && e instanceof ApiError && (e.code === "NOT_FOUND" || e.code === "UNAVAILABLE") ? deps.services?.call(plugin, command, args ?? null, PLUGIN_CALL_MS) : null;
        if (!served) throw e;
        return { result: await served };
      }
    },
    pluginClose: async (instance, plugin) => await deps.callRenderer("plugin.close", { instance, ...(plugin ? { plugin } : {}) }, RENDERER_TIMEOUT) as { closed: string; plugin: string; kind: string },
    focus(tile) {
      requireOpen(tile);
      return deps.callRenderer("tile.focus", { tileId: tile }, RENDERER_TIMEOUT);
    },
    // The window brings it into view and waits for it to draw; the picture is cropped to its box.
    async look(tile) {
      if (!deps.captureWindow) throw new ApiError("UNSUPPORTED", "no window shows tiles here: look at a tile in the app");
      const seen = await deps.callRenderer("tile.look", { tileId: bareOf(tile) }, LOOK_MS + 2_000) as Omit<TileLook, "png" | "width" | "height"> & { rect: TileRect };
      const { rect, ...rest } = seen;
      if (![rect?.x, rect?.y, rect?.width, rect?.height].every((n) => typeof n === "number" && Number.isFinite(n)) || rect.width < 1 || rect.height < 1) {
        throw new ApiError("FAILED", `${bareOf(tile)} is not on the screen`);
      }
      return { ...rest, ...(await deps.captureWindow(rect)) };
    },
    // A plugins folder changed (`hive … install|remove`): a running app picks it up without a
    // restart. Views and agents are scanned by the window, which owns the workspace root; widgets
    // and tools are listed again here, and every window told.
    async rescan(what) {
      if (what === "views" || what === "agents") return await deps.callRenderer(`${what}.rescan`, {}, RENDERER_TIMEOUT);
      if (what === "widgets") deps.widgetsChanged?.();
      else deps.toolsChanged?.();
      return { ok: true };
    },
    // `hive config set` / `hive theme use` edited settings.json: main, which owns the file while
    // it runs, reads it again and tells the windows.
    reloadSettings: () => deps.reloadSettings(),
    hostStatus: () => ({ workspaces: deps.workspaces.repos().map((repo) => ({ repo, workspace: deps.workspaces.ownership(repo)?.workspaceId ?? null })) }),
    serve(folder) {
      if (!path.isAbsolute(folder) || !fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new ApiError("BAD_REQUEST", `${folder} is not a folder on this machine`);
      if (!deps.workspaces.getCore(folder)) deps.workspaces.setCore(folder, { frames: [], tiles: [] });
      return { repo: folder, workspace: deps.workspaces.ownership(folder)!.workspaceId as string };
    },
    async join(link) {
      if (!deps.join) throw new ApiError("UNSUPPORTED", "joining is not served here");
      return await deps.join(link);
    },
  };

  return {
    agentChannel, api, sessionEnded: forgetSessionState, forgetTile: forgetTileState, labelOf: label, spawn: doSpawn, close: closeTile,
    parentOf, onStatus, conversationAsleep,
    asleep: (tileId) => { for (const told of readers.get(bareOf(tileId)) ?? []) told("asleep"); },
  };
}
