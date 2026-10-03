/**
 * HCP verb dispatch. Splits work by where it must run:
 *   - RENDERER verbs (tile.spawn_agent, tile.focus, tool.open, review.open, view.emit) delegate
 *     to `deps.callRenderer` — the request-id-correlated main→renderer channel (the
 *     plan-bridge pattern).
 *   - MAIN verbs run here: agent.send writes to the pty; agent.read awaits the next turn and
 *     returns the reply the agent's plugin reported; the canvas verbs tile.list,
 *     tile.list_frames, tile.rename and tile.close read and write main's workspace store, so
 *     they need no window (docs/design/multiplayer-2026-09-28.md, R5).
 */
import { randomUUID } from "node:crypto";
import { typeKeys } from "@hivemind/agent-host/keys";
import { HcpError, type HcpCall } from "./protocol.js";
import type { TurnTracker } from "./turn-tracker.js";
import type { OutputRecorder } from "./output-recorder.js";
import { mintId, toPtyId as ptyId, toBareId as bareOf } from "@hivemind/workspace-api/tile-id";
import type { TileOpened } from "@hivemind/workspace-api/agents";
import { labelOf as labelIn } from "./names.js";
import { agentById, agentForCmd, agentLaunch, agentOption, cleanName, isSessionId, nextOrdinal, spawnableAgents, workerAgents, type AgentProviderDef, type SpawnOptions } from "@hivemind/agents";
import { canListSessions, listSessions } from "@hivemind/agents/node";
import { BROWSER_TOOL_ID, tileKindAvailability } from "@hivemind/core/tool-plugins";
import type { ToolsSettings } from "@hivemind/core/settings-schema";
import { SUBMIT_DELAY_MS } from "@hivemind/agent-host/agent-io";
import { customDataProblem, isCustomEventName } from "@hivemind/view-sdk/protocol";
import { AGENT_TILE_KIND, isTerminalKind, type CoreLayout, type FrameRecord, type TileRecord } from "@hivemind/workspace-doc/shapes";
import { defaultFrame, frameFor, listFrames, listTiles, type TileFacts } from "@hivemind/workspace-doc/tile-list";
import type { WorkspaceStore } from "@hivemind/workspace-host/store";
import { Refused, type Intent, type Intents } from "@hivemind/workspace-host/intents";
import type { StatusStore } from "@hivemind/agent-host/status-store";
import { tileStatusOf } from "@hivemind/agent-host/tile-status";

/** `view.emit` rate: a steady 10 per second, bursts of 30. */
export const EMIT_RATE = { perSecond: 10, burst: 30 };

/** Validate `view.emit` params; throws BAD_REQUEST with the reason. */
export function parseEmit(p: Record<string, unknown>): { name: string; data: unknown; view?: string; from: "shell" | { tileId: string } } {
  if (!isCustomEventName(p.name)) throw new HcpError("BAD_REQUEST", "name must be dotted lowercase words (a-z, 0-9, -), at most 64 characters, not under hive. or hm.");
  const data = p.data === undefined ? null : p.data;
  const problem = customDataProblem(data);
  if (problem) throw new HcpError("BAD_REQUEST", problem);
  if (p.view !== undefined && (typeof p.view !== "string" || p.view.length === 0 || p.view.length > 256)) throw new HcpError("BAD_REQUEST", "view must be a view id");
  const caller = typeof p.callerTile === "string" && p.callerTile ? bareOf(p.callerTile) : null;
  return { name: p.name, data, ...(p.view ? { view: p.view as string } : {}), from: caller ? { tileId: caller } : "shell" };
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

/** Workflow (multi-agent orchestration) defaults. A `workflow.run` fans work out
 *  to visible worker tiles and awaits their turns. `TIMEOUT` bounds one worker's
 *  turn; `CONCURRENCY` bounds how many workers are live at once (on top of the
 *  per-minute spawn rate gate and the depth cap). */
const WORKFLOW_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const WORKFLOW_DEFAULT_CONCURRENCY = 6;
const WORKFLOW_MAX_CONCURRENCY = 12;
/** Backoff between spawn retries when the rate gate trips mid-fan-out. */
const WORKFLOW_SPAWN_RETRY_MS = 1500;
const WORKFLOW_SPAWN_RETRIES = 6;




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

export interface MethodDeps {
  /** Settled main-process tool preferences; absent means no optional tools enabled. */
  toolsSettings?: () => ToolsSettings;
  /** Provider id of a (user-spawned) tile, from its command — for the
   *  capability checks on read/workflow. Optional: HCP-spawned tiles are
   *  tracked internally. */
  agentOf?: (bareTileId: string) => string | undefined;
  /** Run a renderer verb (returns its result); rejects/throws HcpError on
   *  no-renderer / timeout. */
  callRenderer: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  /** Re-read settings.json (edited by the CLI) and broadcast it. */
  reloadSettings: () => Promise<unknown>;
  /** Write to a tile's pty RIGHT NOW. Returns false if the tile has no live pty.
   *  Raw bytes only (key sequences) — for anything the agent must READ, use
   *  `deliverToTile`, which waits for it to be at its prompt. */
  writeToTile: (tileId: string, data: string) => boolean;
  /** Deliver a MESSAGE to an agent (typed + Enter), holding it until that agent is
   *  back at its prompt. A message typed into a mid-turn TUI lands in the composer
   *  unsubmitted and is never read — see hcp/mailbox.ts. `onSent` fires when the
   *  text actually reaches the terminal (which is when an approval's answer-clock
   *  should start). Returns false only if the tile's pty is dead. */
  deliverToTile: (ptyId: string, text: string, onSent?: () => void) => boolean;
  turns: TurnTracker;
  recorder: OutputRecorder;
  /** Sliding-window spawn gate (reuse the ptySpawn rate-limit). false → refuse. */
  spawnAllowed: () => boolean;
  /** The agent a spawn with no `agent` starts (the user's default, if installed).
   *  Undefined when no agent is installed. May wait: at boot the PATH the answer
   *  depends on is still being read. */
  defaultAgentId?: () => string | undefined | Promise<string | undefined>;
  /** The agent's CLI is where it would run (this machine, or the caller's remote host). Absent = assume it is. */
  agentInstalled?: (def: AgentProviderDef, callerTile?: string) => boolean | Promise<boolean>;
  /** Pipe src's finished-turn replies into dst's input. Returns false on a bad
   *  pair (e.g. src === dst). */
  connect: (srcTileId: string, dstTileId: string) => boolean;
  /** Remove a pipe (or all of src's pipes when dst is omitted). */
  disconnect: (srcTileId: string, dstTileId?: string) => void;
  /** Drop a tile from the pipe graph entirely (both directions) on close. */
  forgetPipes: (tileId: string) => void;
  /** Draw/erase the persistent spawn-parentage "wire" (parent → child). ALWAYS
   *  drawn on spawn, independent of the report/data pipe. Call with parent=null,
   *  connected=false to drop every spawn link touching `child` (on close). */
  spawnEdge: (child: string, parent: string | null, connected: boolean) => void;
  /** Record (or clear, with null) a worker's supervision policy. Main injects it
   *  as HIVE_SUPERVISE into the worker's spawn env so the daemon installs the
   *  permission-broker hook. */
  setSupervise: (tileId: string, spec: string | null) => void;
  /** Push a control-plane "wait" status for a tile (e.g. "awaiting_approval")
   *  to the renderer's status bus, or null to clear. */
  /** A supervised worker waits on its supervisor (true) or no longer does (false). */
  awaitingApproval: (tileId: string, waiting: boolean) => void;
  /** The workspaces main has open. The canvas verbs read them, and write them as `control`;
   *  their windows follow. */
  workspaces: Pick<WorkspaceStore, "workspaceOf" | "getCore" | "addTile" | "renameTile" | "removeTile">;
  /** The workspace the window the user is at shows, and the frame the user is in there, if
   *  any: what a caller in no tile (a terminal, a script) acts on. */
  shownWorkspace: () => { repo: string; frame: string | null } | null;
  /** The launch options the user saved for an agent. */
  launchOptions: (agentId: string) => SpawnOptions;
  /** Tell the windows about a tile the control plane is opening, before it reaches the layout:
   *  the prompt to start it with, and whether to bring it forward. */
  announceSpawn: (spawn: TileOpened) => void;
  /** Every session's status, as its host reports it. */
  status: Pick<StatusStore, "get">;
  /** End the session a tile runs (by its pty id), as its window's kill does. */
  endSession: (ptyId: string) => void;
  /** Whether main holds a session by this pty id (a window showed it, here or remote). */
  sessionHeld: (ptyId: string) => boolean;
  /** Carries out every verb with an effect, and records it in the audit log (R7). */
  intents: Pick<Intents, "perform">;
}

/** How the control plane writes a workspace: its windows hear of it, and it hears of none. */
const CONTROL = { writer: "control" };

const RENDERER_TIMEOUT = 15_000;
const DEFAULT_READ_TIMEOUT = 120_000;
const REVIEW_TIMEOUT = 24 * 60 * 60 * 1000; // human review may take a long time

export interface Dispatcher {
  /** Handle one HCP method call, made by `call.actor`. */
  dispatch: (method: string, params: unknown, call: HcpCall) => Promise<unknown>;
  /** Drop ALL per-tile HCP state for a tile that has gone away, WITHOUT closing it
   *  as `tile.close` does. MUST be called on every pty-exit and
   *  user-close path — otherwise the maps (parentOf/depthOf/sendSeq/approveCache/
   *  pendingApprovals) leak, a blocked agent.read/approval on the dead worker hangs
   *  its full timeout instead of resolving, and its UI "awaiting" status lingers.
   *  Idempotent — safe to call twice (e.g. tile.close then the resulting pty-exit). */
  forgetTile: (tileId: string) => void;
  /** What the control plane's messages call a tile (names.ts). */
  labelOf: (tileId: string) => string;
  /** Spawn an agent, as `tile.spawn_agent` does, without recording it: the caller has (M5). */
  spawn: (opts: { agent?: string; frame?: string; prompt?: string; model?: string; mode?: string; name?: string; repo: string; attended: true }) => Promise<string>;
  /** Close a tile, as `tile.close` does, without recording it: the caller has (M5). */
  close: (tileId: string) => Promise<unknown>;
}

export function makeDispatch(deps: MethodDeps): Dispatcher {
  // Per-tile read epoch: set at spawn/send so agent.read waits for the turn that
  // FOLLOWS the prompt we just delivered (not a stale earlier turn).
  const sendSeq = new Map<string, number>();
  const emitBucket = tokenBucket(EMIT_RATE);
  const sendMark = new Map<string, number>();

  // Bare↔pty id mapping lives in @hivemind/workspace-api/tile-id (imported as ptyId/bareOf). The
  // pty, recorder, turn-tracker and HIVEMIND_TILE are keyed by the pty id; the
  // control surface uses the bare id.

  // child (bare) → parent (bare): set when a parent spawns a child via
  // tile.spawn_agent, read by agent.report so a worker can push a result back to
  // the agent that spawned it (mailbox-style, no polling).
  const parentOf = new Map<string, string>();
  // bare tileId → spawn depth (HCP-spawned children only; user-spawned agents
  // are absent → treated as depth 0). Enforced against MAX_SPAWN_DEPTH.
  const depthOf = new Map<string, number>();
  /** bare tileId → provider id, for tiles spawned through HCP (user-spawned
   *  tiles are resolved by deps.agentOf from their command). */
  const agentOfTile = new Map<string, string>();
  const providerOf = (tileId: string): string | undefined => agentOfTile.get(bareOf(tileId)) ?? deps.agentOf?.(bareOf(tileId));
  /** Refuse a verb that needs a deterministic turn signal from a provider that
   *  has none — an honest UNSUPPORTED instead of a read that times out. */
  const requireTurnSignal = (tileId: string, verb: string): void => {
    const id = providerOf(tileId);
    const def = id ? agentById(id) : undefined;
    if (def && !def.caps.turnSignal) {
      throw new HcpError("UNSUPPORTED", `${verb}: ${def.id} has no turn signal (${def.note ?? "scrape-only status"}) — drive it by hand or use a worker runtime: ${workerAgents().map((d) => d.id).join(", ")}`);
    }
  };
  // Agent-supervised approvals (HCP Phase 6). A supervised worker's PreToolUse
  // broker hook calls `agent.await_approval` (held here until the parent answers
  // via `agent.approve`). `approveCache` remembers always/never per worker+tool.
  const pendingApprovals = new Map<string, { resolve: (d: { decision: "allow" | "deny"; reason?: string }) => void; timer: ReturnType<typeof setTimeout>; cacheKey: string; worker: string; supervisor: string }>();
  const approveCache = new Map<string, "allow" | "deny">();

  const armRead = (tileId: string) => {
    const pid = ptyId(tileId);
    sendSeq.set(pid, deps.turns.currentSeq(pid));
    sendMark.set(pid, deps.recorder.mark(pid));
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

  // Spawn one child tile and wire up its bookkeeping (depth, parent, auto-report,
  // supervision, read epoch). Shared by `tile.spawn_agent` and `workflow.run` so
  // both enforce the same depth/rate gates. Throws HcpError on depth/rate/spawn
  // failure. `report` defaults to on (draws the auto-report edge to the parent);
  // workflow workers pass report:false and gather via waitForTurn instead.
  const doSpawn = async (opts: {
    agent?: unknown; prompt?: unknown; frame?: unknown; mode?: unknown; model?: unknown;
    callerTile?: unknown; report?: unknown; supervise?: unknown; name?: unknown; resume?: unknown;
    /** The workspace to open it in (a person's spawn from another of their devices, M5), not the
     *  caller's or the one the user's window shows. */
    repo?: string;
    /** A person is at it, from another of their devices: never its unattended mode unless `mode`
     *  says so. */
    attended?: boolean;
  }): Promise<string> => {
    const callerDepth = opts.callerTile ? (depthOf.get(bareOf(String(opts.callerTile))) ?? 0) : 0;
    const childDepth = callerDepth + 1;
    if (childDepth > MAX_SPAWN_DEPTH) {
      throw new HcpError("DEPTH_EXCEEDED", `agent spawn depth ${childDepth} exceeds max ${MAX_SPAWN_DEPTH}`);
    }
    if (!deps.spawnAllowed()) throw new HcpError("RATE_LIMITED", "spawn rate limit exceeded");
    const agent = opts.agent != null ? String(opts.agent) : await deps.defaultAgentId?.();
    // Nothing compiled in to fall back to: an empty catalog means no agent can start.
    if (!agent) throw new HcpError("BAD_REQUEST", "no agent installed — install one from Settings ▸ Plugins");
    const def = agentById(agent);
    if (!def || !def.enabled) {
      throw new HcpError("BAD_REQUEST", `unknown agent '${agent}' — spawnable: ${spawnableAgents().map((d) => d.id).join(", ")}`);
    }
    if (deps.agentInstalled && !(await deps.agentInstalled(def, opts.callerTile ? String(opts.callerTile) : undefined))) {
      throw new HcpError("UNSUPPORTED", `${def.label} is not installed on this machine (no ${def.bin} on PATH)${def.install ? ` — get it at ${def.install.url}` : ""}`);
    }
    const sup = normalizeSupervise(opts.supervise);
    // Supervision is brokered TO the caller's tile. Without one there is nobody to ask,
    // and the policy would be dropped silently while the caller believes it has a gate.
    if (sup && !opts.callerTile) {
      throw new HcpError("BAD_REQUEST", "supervise needs a supervising agent: run this from an agent tile, or spawn without --supervise");
    }
    // pi cannot be supervised. It has NO permission system, so the only gate would be
    // one we inject — which must fail CLOSED (no human prompt to fall back to) and
    // therefore bricks the worker on any hiccup. Refuse LOUDLY rather than spawning
    // an ungated worker the caller believes it is supervising: a false gate is worse
    // than no gate. (A user-opened pi tile is fully autonomous too — this changes
    // nothing about pi's actual authority.)
    if (sup && superviseUnsupported(agent)) {
      throw new HcpError(
        "BAD_REQUEST",
        `${agent} workers cannot be supervised — ${agent} has no permission system, so there is nothing to broker. ` +
          `Spawn this worker WITHOUT supervise (it runs autonomously, like any ${agent} tile), ` +
          `or spawn a claude worker with supervise if you need to gate its tools.`,
      );
    }
    // No human at a delegated worker's tile, so it runs in the agent's unattended
    // mode — unless the caller chose one, or it is supervised (its broker hook
    // only fires while permissions are not skipped).
    const mode = opts.mode != null ? opts.mode : sup || opts.attended ? undefined : agentOption(def, "mode")?.unattended;
    const resume = opts.resume != null ? String(opts.resume) : undefined;
    if (resume !== undefined) {
      if (!def.session?.resume) throw new HcpError("UNSUPPORTED", `${def.label} cannot resume a session`);
      if (!isSessionId(resume)) throw new HcpError("BAD_REQUEST", "resume must be a session id");
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
    // `background` = a silent worker (report:false → gathered in bulk, e.g. a workflow worker):
    // its window does not bring it forward, and does not announce each one finishing.
    const tileId = openTile(opts.callerTile, opts.frame, (ws) => ({
      id: mintId(`tile-${def.id}`), kind: AGENT_TILE_KIND,
      ...agentLaunch(def, { options, labels: ws.tiles.map((t) => t.label), prompt, resume }),
    }), { name, prompt, background: opts.report === false, repo: opts.repo });
    const res = { tileId };
    depthOf.set(res.tileId, childDepth);
    agentOfTile.set(res.tileId, agent);
    if (opts.callerTile) {
      const parentBare = bareOf(String(opts.callerTile));
      parentOf.set(res.tileId, parentBare);
      if (parentBare !== res.tileId) {
        // The parentage WIRE is drawn ALWAYS — for sub-agents AND background
        // workflow workers (report:false) — so every spawned tile visibly links
        // to the agent that spawned it. The report/data pipe (animated) is still
        // separate and only for report:true.
        deps.spawnEdge(res.tileId, parentBare, true);
        if (opts.report !== false) deps.connect(res.tileId, parentBare);
      }
      if (sup) deps.setSupervise(res.tileId, sup);
    }
    armRead(res.tileId);
    return res.tileId;
  };

  // Drop ALL per-tile HCP state (pid-keyed: turns/recorder/epochs; bare-keyed:
  // pipes/parent/depth/supervision/approvals). Runs on EVERY teardown path — the
  // `tile.close` verb, and (via forgetTile below) every pty-exit/user-close. Wakes
  // anything blocked on the dead tile (readers via turns.forget → seq -1; approvals
  // resolved "worker closed") so a crash doesn't hang a parent for the full timeout.
  // Idempotent: every op is a delete/forget that no-ops when already gone.
  const forgetTileState = (tileId: string): void => {
    const pid = ptyId(tileId);
    const bare = bareOf(tileId);
    deps.turns.forget(pid);
    deps.recorder.forget(pid);
    deps.forgetPipes(bare);
    deps.spawnEdge(bare, null, false); // drop spawn wires where this tile is parent OR child
    sendSeq.delete(pid);
    sendMark.delete(pid);
    pendingSend.delete(pid);
    parentOf.delete(bare);
    for (const [child, parent] of parentOf) if (parent === bare) parentOf.delete(child);
    depthOf.delete(bare);
    deps.setSupervise(bare, null);
    for (const [reqId, pend] of pendingApprovals) {
      if (pend.cacheKey.startsWith(`${bare}:`)) {
        clearTimeout(pend.timer);
        pend.resolve({ decision: "deny", reason: "worker closed" });
        pendingApprovals.delete(reqId);
      }
    }
    for (const key of approveCache.keys()) if (key.startsWith(`${bare}:`)) approveCache.delete(key);
    deps.awaitingApproval(bare, false);
  };

  // Close a tile, with no window needed: it leaves its workspace and the session it runs ends, but
  // not one it adopted (`hive run`, another device), which is someone else's job and keeps running.
  // Then its state here goes. Shared by the `tile.close` verb and workflow's `close_when_done`.
  const closeTile = async (tileId: string): Promise<unknown> => {
    const closed = deps.workspaces.removeTile(bareOf(tileId), CONTROL)?.tile;
    if (!closed) throw new HcpError("TILE_NOT_FOUND", `no open workspace has tile ${bareOf(tileId)}`);
    if (isTerminalKind(closed.kind) && !closed.session) deps.endSession(ptyId(tileId));
    forgetTileState(tileId);
    return { ok: true };
  };

  // The workspace a canvas verb acts on: the one holding the caller's tile, else the one the
  // user's window shows (with the frame the user is in there); null with neither.
  const workspaceFor = (callerTile: unknown): { repo: string; core: CoreLayout; frame: string | null } | null => {
    const held = typeof callerTile === "string" && callerTile ? deps.workspaces.workspaceOf(bareOf(callerTile)) : null;
    const shown = deps.shownWorkspace();
    const repo = held ?? shown?.repo ?? null;
    if (repo === null) return null;
    return { repo, core: deps.workspaces.getCore(repo) ?? { frames: [], tiles: [] }, frame: shown?.repo === repo ? shown.frame : null };
  };
  const layoutFor = (callerTile: unknown): CoreLayout => workspaceFor(callerTile)?.core ?? { frames: [], tiles: [] };

  // Where the control plane opens a tile, and tells the windows so: the workspace and frame (the
  // one named, else beside the caller, else the one the user is in, else the first; none in a
  // workspace with no frames, where the window that lays it out makes one).
  const openTile = (
    callerTile: unknown, named: unknown,
    make: (ws: CoreLayout) => TileRecord, at: { name?: string; prompt?: string; background: boolean; repo?: string },
  ): string => {
    const core = at.repo === undefined ? null : deps.workspaces.getCore(at.repo);
    const ws = at.repo === undefined ? workspaceFor(callerTile) : core && { repo: at.repo, core, frame: null };
    if (!ws) throw new HcpError("NOT_FOUND", "no workspace is open: open one in the app first");
    let frame: FrameRecord | undefined;
    const caller = typeof callerTile === "string" && callerTile ? bareOf(callerTile) : undefined;
    if (named != null && named !== "") {
      frame = frameFor(ws.core.frames, String(named));
      if (!frame) throw new HcpError("NOT_FOUND", `no frame answers to "${String(named)}"`);
    } else {
      frame = defaultFrame(ws.core.frames, { caller: caller && ws.core.frameOf?.[caller], selected: ws.frame });
    }
    const tile = make(ws.core);
    const near = caller && frame && ws.core.frameOf?.[caller] === frame.id ? caller : undefined;
    deps.announceSpawn({ tileId: tile.id, repo: ws.repo, prompt: at.prompt, background: at.background, ...(near ? { near } : {}) });
    deps.workspaces.addTile(ws.repo, tile, { frame: frame?.id, name: at.name }, CONTROL);
    return tile.id;
  };

  // What only the running app knows about a workspace's tiles, for the list.
  const factsOf = (tiles: readonly TileRecord[]): TileFacts<TileRecord> => ({
    status: (tileId) => {
      const s = deps.status.get(tileId);
      return s ? tileStatusOf(s).status : null;
    },
    titles: Object.fromEntries(tiles.flatMap((t) => {
      const title = deps.status.get(t.id)?.title;
      return title ? [[t.id, title]] : [];
    })),
    agent: (t) => (t.kind === AGENT_TILE_KIND ? agentForCmd(t.cmd)?.id : undefined),
  });

  const label = (tileId: string): string => labelIn(tileId, deps.workspaces, deps.status);

  // A verb with an effect is carried out through the intents, which check it against the policy
  // and record it. The others read, are a hook reporting, or only move a window's view.
  const effect = <R>(call: HcpCall, intent: Intent<R>, run: () => Promise<R>): Promise<R> =>
    deps.intents.perform(call.actor, intent, run).catch((e: unknown) => {
      throw e instanceof Refused ? new HcpError("UNAUTHORIZED", e.message) : e;
    });
  const tileOf = (id: unknown): string | undefined => (typeof id === "string" && id ? bareOf(id) : undefined);
  // A pipe, or every pipe out of a tile: `src->dst`, `src->*`.
  const pipeOf = (src: unknown, dst: unknown): string | undefined => {
    const from = tileOf(src);
    return from && `${from}->${tileOf(dst) ?? "*"}`;
  };

  // Multi-agent orchestration. Fan a list of items out to visible worker
  // tiles (or chain them as a pipeline), await each worker's turn
  // deterministically via the turn-tracker (NOT screen-scrape), and return
  // the aggregated replies. Workers are spawned report:false —
  // the workflow gathers them itself, so their replies don't also spam the
  // orchestrator's terminal. The orchestrator's `hive ctl workflow` call blocks until
  // this returns (`hive ctl workflow` blocks with a matching client ceiling).
  const runWorkflow = async (p: Record<string, unknown>, call: HcpCall): Promise<unknown> => {
    const shape = String(p.shape ?? "fanout");
    const caller = p.callerTile != null ? String(p.callerTile) : undefined;
    const agent = p.agent != null ? String(p.agent) : await deps.defaultAgentId?.();
    if (!agent) throw new HcpError("BAD_REQUEST", "no agent installed — install one from Settings ▸ Plugins");
    {
      const def = agentById(agent);
      if (!def || !def.enabled) throw new HcpError("BAD_REQUEST", `unknown agent '${agent}' — spawnable: ${spawnableAgents().map((d) => d.id).join(", ")}`);
      if (!def.caps.turnSignal) throw new HcpError("UNSUPPORTED", `workflow.run: ${def.id} has no turn signal, so its workers' replies cannot be gathered (${def.note ?? "scrape-only status"}) — use a worker runtime: ${workerAgents().map((d) => d.id).join(", ")}`);
    }
    const frame = p.frame != null ? String(p.frame) : undefined;
    // claude-only model alias applied to every worker in the fleet.
    const model = p.model != null ? String(p.model) : undefined;
    const supervise = p.supervise;
    const perTurnMs = typeof p.timeout_ms === "number" ? p.timeout_ms : WORKFLOW_DEFAULT_TIMEOUT_MS;
    const maxConc = Math.max(1, Math.min(Number(p.max_concurrent ?? WORKFLOW_DEFAULT_CONCURRENCY), WORKFLOW_MAX_CONCURRENCY));
    const closeWhenDone = p.close_when_done === true;

    const delay = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });
    const fill = (tmpl: string, item: string) => tmpl.replace(/\{item\}/g, item);

    // Spawn one worker (retrying through transient rate-limits), await its
    // turn, take its reply. Returns a per-worker result. Its spawn and its close
    // are the caller's intents, as they would be asked one by one.
    type WR = { item: string; tileId: string | null; status: "turn" | "timeout" | "error"; text: string | null };
    const runWorker = async (label: string, prompt: string): Promise<WR> => {
      let tileId: string;
      try {
        tileId = await effect(call, { verb: "tile.spawn_agent", target: (id) => id }, () =>
          spawnRetry({ agent, prompt, frame, model, callerTile: caller, report: false, supervise, name: label }));
      } catch (e) {
        return { item: label, tileId: null, status: "error", text: (e as Error).message };
      }
      const pid = ptyId(tileId);
      const afterSeq = sendSeq.get(pid) ?? deps.turns.currentSeq(pid);
      const rec = await deps.turns.waitForTurn(pid, afterSeq, perTurnMs);
      const text = rec?.text && rec.text.length > 0 ? rec.text : null;
      const status: WR["status"] = !rec ? "timeout" : rec.seq === -1 ? "error" : "turn";
      if (closeWhenDone && status === "turn") {
        try { await effect(call, { verb: "tile.close", target: tileId }, () => closeTile(tileId)); } catch { /* best-effort */ }
      }
      return { item: label, tileId, status, text };
    };
    async function spawnRetry(opts: Parameters<typeof doSpawn>[0]): Promise<string> {
      for (let i = 0; ; i++) {
        try { return await doSpawn(opts); }
        catch (e) {
          if (e instanceof HcpError && e.code === "RATE_LIMITED" && i < WORKFLOW_SPAWN_RETRIES) { await delay(WORKFLOW_SPAWN_RETRY_MS); continue; }
          throw e;
        }
      }
    }
    // Fixed-size worker pool: at most `n` runWorker calls live at once.
    const pool = async <T, R>(xs: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> => {
      const out = new Array<R>(xs.length);
      let next = 0;
      const slot = async () => {
        for (;;) {
          const i = next++;
          if (i >= xs.length) return;
          out[i] = await fn(xs[i]!, i);
        }
      };
      await Promise.all(Array.from({ length: Math.min(n, xs.length) }, slot));
      return out;
    };

    if (shape === "fanout" || shape === "mapreduce") {
      const items = Array.isArray(p.items) ? p.items.map(String) : [];
      if (!items.length) throw new HcpError("BAD_REQUEST", "items required (a non-empty array) for fanout/mapreduce");
      const prompt = String(p.prompt ?? "");
      if (!prompt) throw new HcpError("BAD_REQUEST", "prompt required for fanout/mapreduce");
      const results = await pool(items, maxConc, (it) => runWorker(it, fill(prompt, it)));
      if (shape === "fanout") return { shape, items: results };
      // mapreduce: feed every worker's output into one reducer tile.
      const reduceTmpl = String(p.reduce_prompt ?? "");
      if (!reduceTmpl) throw new HcpError("BAD_REQUEST", "reduce_prompt required for mapreduce");
      const joined = results.map((r) => `## ${r.item}\n${r.text ?? "(no output)"}`).join("\n\n");
      const reducer = await runWorker("(reduce)", reduceTmpl.replace(/\{results\}/g, joined));
      return { shape, items: results, reduced: reducer.text, reducerStatus: reducer.status };
    }

    if (shape === "pipeline") {
      // Sequential chain: each stage's prompt may reference {input} (the prior
      // stage's reply). Stops the chain on a timeout/error stage.
      const stages = Array.isArray(p.stages) ? p.stages.map(String) : [];
      if (!stages.length) throw new HcpError("BAD_REQUEST", "stages required (a non-empty array) for pipeline");
      const steps: WR[] = [];
      let prev: string | null = p.input != null ? String(p.input) : null;
      for (let s = 0; s < stages.length; s++) {
        const r = await runWorker(`stage ${s + 1}`, stages[s]!.replace(/\{input\}/g, prev ?? ""));
        steps.push(r);
        if (r.status !== "turn") break; // dead chain — surface the partial run
        prev = r.text;
      }
      return { shape, steps, output: prev };
    }

    throw new HcpError("BAD_REQUEST", `unknown workflow shape '${shape}' (expected fanout | pipeline | mapreduce)`);
  };

  const dispatch = async (method: string, rawParams: unknown, call: HcpCall): Promise<unknown> => {
    let p = (rawParams ?? {}) as Record<string, unknown>;
    // A tile speaks for itself: the caller a call names is the tile its token names. Naming
    // another is refused (and recorded); a call that names none is its tile's all the same. A
    // person may act for any tile.
    if (call.actor.kind === "tile") {
      const named = tileOf(p.callerTile);
      if (named && named !== call.actor.tile) return effect(call, { verb: method, target: named, onlyBy: named }, async () => undefined);
      if (!named) p = { ...p, callerTile: ptyId(call.actor.tile) }; // as `hive ctl` names it: $HIVEMIND_TILE
    }
    switch (method) {
      case "tile.spawn_agent":
        // Anti-fork-bomb depth + rate gates, parent/auto-report/supervision
        // wiring, and the read-epoch arm all live in doSpawn (shared with
        // workflow.run). AUTO-REPORT is on unless report:false; the read epoch is
        // armed so a follow-up agent.read waits for THIS agent's first turn.
        return effect(call, { verb: method, target: (r) => r.tileId }, async () => ({
          tileId: await doSpawn({
            agent: p.agent, name: p.name, prompt: p.prompt, frame: p.frame, mode: p.mode, model: p.model,
            callerTile: p.callerTile, report: p.report, supervise: p.supervise, resume: p.resume,
          }),
        }));

      case "agent.sessions": {
        const def = agentById(String(p.agent ?? ""));
        if (!def) throw new HcpError("BAD_REQUEST", `unknown agent '${String(p.agent ?? "")}'`);
        if (!canListSessions(def)) throw new HcpError("UNSUPPORTED", `${def.label} does not say where its sessions are, so they cannot be listed`);
        const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 500) : undefined;
        const sessions = await listSessions(def, { ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}), ...(limit ? { limit } : {}) });
        return { agent: def.id, resumable: !!def.session?.resume, sessions };
      }

      case "agent.send":
        return effect(call, { verb: method, target: tileOf(p.tileId) }, async () => {
          const tileId = String(p.tileId ?? "");
          const text = String(p.text ?? "");
          if (!tileId) throw new HcpError("BAD_REQUEST", "tileId required");
          const submit = p.submit !== false; // default: press Enter
          const pid = ptyId(tileId);
          // With submit (the default) this is a MESSAGE: deliver via the mailbox, which
          // types text-then-Enter as separate writes (a bundled newline is dropped by
          // claude's TUI) and, crucially, HOLDS it if the target agent is mid-turn —
          // otherwise it strands in the composer, unsubmitted and unread.
          // submit:false is a raw paste into the composer, which is only meaningful
          // right now, so it stays an immediate write.
          let ok: boolean;
          if (submit) {
            const sent = holdUntilSent(pid);
            ok = deps.deliverToTile(pid, text, () => { armRead(tileId); sent(); });
            if (!ok) sent();
          } else {
            armRead(tileId); // a raw paste is written immediately, so now IS delivery
            ok = deps.writeToTile(pid, text);
          }
          if (!ok) throw new HcpError("TILE_NOT_FOUND", `no live agent for tile ${tileId}`);
          return { ok: true };
        });

      case "agent.send_keys":
        return effect(call, { verb: method, target: tileOf(p.tileId) }, async () => {
          // Send a sequence of symbolic keys to a tile's TUI (e.g. answer a native
          // AskUserQuestion picker: ["Down","Enter"]). Each token maps via KEYMAP
          // (arrows/enter/esc/…) or is sent as literal text. Staggered so the TUI
          // registers each key — a bundled arrow+enter write can miss the move.
          const tileId = String(p.tileId ?? "");
          if (!tileId) throw new HcpError("BAD_REQUEST", "tileId required");
          const raw = p.keys;
          const keys = Array.isArray(raw) ? raw.map(String) : raw != null ? [String(raw)] : [];
          if (!keys.length) throw new HcpError("BAD_REQUEST", "keys required");
          const pid = ptyId(tileId);
          armRead(tileId); // keys can submit a prompt; a following read wants the turn they cause
          if (!typeKeys((bytes) => deps.writeToTile(pid, bytes), keys)) throw new HcpError("TILE_NOT_FOUND", `no live agent for tile ${tileId}`);
          return { ok: true, keys: keys.length };
        });

      case "agent.report":
        return effect(call, { verb: method, target: (r) => r.parent }, async () => {
          // A spawned worker pushes a result back to the agent that spawned it.
          // The caller passes its OWN tile id (HIVEMIND_TILE); we look up its
          // parent and deliver the message into the parent's terminal (typed +
          // Enter, like agent.send) so the parent reads it on its next turn.
          const child = bareOf(String(p.callerTile ?? ""));
          const parent = parentOf.get(child);
          if (!parent) throw new HcpError("TILE_NOT_FOUND", "no parent agent to report to");
          const message = String(p.message ?? "").trim();
          if (!message) throw new HcpError("BAD_REQUEST", "message required");
          const banner = `\n[hive] report from ${label(child)}:\n${message}\n`;
          // Held if the parent is mid-turn — a report typed into a busy TUI never
          // gets read, and the worker thinks it delivered.
          if (!deps.deliverToTile(ptyId(parent), banner)) {
            throw new HcpError("TILE_NOT_FOUND", `parent agent ${parent} is gone — report not delivered`);
          }
          // Single-delivery ladder: the worker authored its own summary this turn, so
          // when its turn ends, DON'T also auto-forward the raw turn (that would be a
          // second message the parent re-processes). recordTurn reads + clears this.
          deps.turns.markReported(ptyId(child));
          return { delivered: true, parent };
        });

      case "agent.reply": {
        // The agent's plugin hands over this turn's reply before it reports the turn end.
        const tileId = String(p.tileId ?? "");
        const text = typeof p.text === "string" ? p.text : "";
        if (!tileId || !text) throw new HcpError("BAD_REQUEST", "tileId and text required");
        deps.turns.recordReply(ptyId(tileId), text);
        return { ok: true };
      }

      case "agent.await_approval": {
        // Called by a SUPERVISED worker's PreToolUse broker hook before a tool
        // runs. Resolve from the remember-cache, else ask the parent and BLOCK
        // (held in pendingApprovals) until `agent.approve` or the timeout.
        const worker = bareOf(String(p.callerTile ?? ""));
        const tool = String(p.tool_name ?? "");
        if (!worker || !tool) return { decision: "ask" };
        const cacheKey = `${worker}:${tool}`;
        const cached = approveCache.get(cacheKey);
        if (cached) return { decision: cached };
        const parent = parentOf.get(worker);
        if (!parent) return { decision: "ask" }; // no supervisor → fall back to human prompt
        // Asking is the effect: the question is typed into the supervisor's terminal, and the
        // worker waits for the answer.
        return effect(call, { verb: method, target: parent, detail: tool.slice(0, 128) }, async () => {
          const inp = (p.tool_input ?? {}) as Record<string, unknown>;
          const reqId = randomUUID();
          const summary = summarizeTool(tool, inp);
          const banner =
            `\n[hive] APPROVAL — worker ${label(worker)} wants to run ${tool}: ${summary}\n` +
            `Reply: hive ctl approve ${reqId} allow|deny|always|never  (allow = this call; always = this tool, for this worker)\n`;
          // Surface the pause in the UI: this worker is now waiting on its parent.
          deps.awaitingApproval(worker, true);
          return await new Promise((resolve) => {
            const done = (decision: "ask") => {
              const pend = pendingApprovals.get(reqId);
              if (!pend) return; // answered already
              clearTimeout(pend.timer);
              pendingApprovals.delete(reqId);
              deps.awaitingApproval(worker, false);
              resolve({ decision }); // no answer → "ask" (claude: human prompt; pi: blocks)
            };
            // Two timers, never both live. Until the banner is DELIVERED, only the
            // ceiling runs — a supervisor that never returns to its prompt (dead,
            // wedged) can't hang the worker or leak the pending entry forever. On
            // delivery, swap the ceiling for the answer clock: it starts WHEN THE
            // PARENT ACTUALLY SEES THE REQUEST, not when the worker asked — the banner
            // may have been held minutes while the parent was mid-turn, and a request
            // that waited 8 minutes must not then get 1 to be answered.
            const ceiling = setTimeout(() => done("ask"), APPROVAL_MAX_WAIT_MS);
            ceiling.unref?.();
            pendingApprovals.set(reqId, { resolve, timer: ceiling, cacheKey, worker, supervisor: parent });
            // A hook that stopped waiting (it gave up and asked the agent's own prompt) has no use
            // for an answer: the question ends with it, and an answer after that is told so
            // rather than told it worked.
            if (call.signal?.aborted) return done("ask");
            call.signal?.addEventListener("abort", () => done("ask"), { once: true });
            const armAnswerTimeout = () => {
              const pend = pendingApprovals.get(reqId);
              if (!pend) return; // already answered
              clearTimeout(pend.timer); // drop the ceiling
              const t = setTimeout(() => done("ask"), APPROVAL_TIMEOUT_MS);
              t.unref?.();
              pend.timer = t;
            };
            const delivered = deps.deliverToTile(ptyId(parent), banner, armAnswerTimeout);
            if (!delivered) done("ask"); // parent's pty is gone → don't hang the worker
          });
        });
      }

      case "agent.approve": {
        // The supervising agent answers an approval request (by reqId). always /
        // never also remember the decision for this worker+tool (no more
        // round-trips for it). Only the supervisor it was asked of may answer it, or a
        // person: never the worker itself, nor another worker.
        const reqId = String(p.reqId ?? "");
        const decision = String(p.decision ?? "");
        const pend = pendingApprovals.get(reqId);
        const d = decision === "allow" || decision === "always" ? "allow" : decision === "deny" || decision === "never" ? "deny" : null;
        return effect(call, { verb: method, target: pend?.worker, detail: d ? decision : undefined, onlyBy: pend?.supervisor }, async () => {
          const reason = p.reason != null ? String(p.reason) : undefined;
          if (!pend) throw new HcpError("BAD_REQUEST", `no approval ${reqId} is waiting: it was answered, ran out of time, or its worker stopped waiting`);
          if (!d) throw new HcpError("BAD_REQUEST", "decision must be allow | deny | always | never");
          if (decision === "always") approveCache.set(pend.cacheKey, "allow");
          if (decision === "never") approveCache.set(pend.cacheKey, "deny");
          clearTimeout(pend.timer);
          pendingApprovals.delete(reqId);
          deps.awaitingApproval(pend.worker, false); // resolved → clear the "waiting" status
          pend.resolve({ decision: d, reason });
          return { ok: true, decision: d };
        });
      }

      case "agent.read": {
        const tileId = String(p.tileId ?? "");
        if (!tileId) throw new HcpError("BAD_REQUEST", "tileId required");
        requireTurnSignal(tileId, "agent.read");
        const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_READ_TIMEOUT;
        const pid = ptyId(tileId);
        // A tile no open workspace holds, running no session main holds, is gone: say so now
        // rather than wait out the timeout for a turn that cannot come. A tile still starting
        // is in its workspace already.
        if (deps.workspaces.workspaceOf(bareOf(tileId)) === null && !deps.sessionHeld(pid)) {
          throw new HcpError("TILE_NOT_FOUND", `no tile ${bareOf(tileId)} is open`);
        }
        // A send may still be queued behind the turn in flight; its epoch is armed when
        // it is typed, so wait for that before deciding which turn this read wants.
        // One budget for the whole read: waiting for a held send to be typed must not
        // extend the call past the ceiling the caller (and the CLI) is waiting on.
        const deadline = Date.now() + timeoutMs;
        const pending = pendingSend.get(pid);
        if (pending) await Promise.race([pending, new Promise<void>((r) => { const t = setTimeout(r, timeoutMs); t.unref?.(); })]);
        const afterSeq = sendSeq.get(pid) ?? deps.turns.currentSeq(pid);
        const rec = await deps.turns.waitForTurn(pid, afterSeq, Math.max(0, deadline - Date.now()));
        // A tile that died under us is not "still working" — say so, and keep the read's
        // shape so a caller parsing finalStatus does not have to special-case an error.
        if (rec && rec.seq === -1) {
          return { text: null, finalStatus: "closed", truncated: false, note: "tile closed while waiting" };
        }
        // Consume this turn: without advancing the epoch the NEXT read returns the same
        // turn instantly, so a poll loop can never tell a new answer from the old one.
        if (rec) sendSeq.set(pid, rec.seq);
        if (rec && typeof rec.text === "string" && rec.text.length > 0) return { text: rec.text, finalStatus: "turn", truncated: false };
        if (rec) return { text: null, finalStatus: "turn", truncated: false, note: "turn completed but carried no readable reply" };
        // No completed turn within the timeout. Report status honestly instead of
        // scraping the raw ANSI terminal buffer (which returned garbled bytes, not
        // the agent's words). The agent is still working; if it was spawned with
        // report:true it will auto-deliver its reply to the parent when done.
        return { text: null, finalStatus: "timeout", truncated: false, note: "agent still working — no completed turn within timeout" };
      }

      case "workflow.run":
        return effect(call, { verb: "workflow.run" }, () => runWorkflow(p, call));

      // ── canvas verbs (renderer) ──────────────────────────────────────────
      case "tool.open":
        return effect(call, { verb: method, target: (r) => r.tileId }, async () => {
          if (p.tool !== BROWSER_TOOL_ID) throw new HcpError("UNSUPPORTED", "Unknown tool id");
          const availability = tileKindAvailability("browser", deps.toolsSettings?.() ?? { enabledPlugins: [], disabledTools: [] });
          if (!availability?.available) throw new HcpError("UNAUTHORIZED", "Browser is disabled; enable it in Settings under Tools");
          if (p.frame !== undefined && (typeof p.frame !== "string" || !p.frame || p.frame.length > 256)) throw new HcpError("BAD_REQUEST", "frame must be an id");
          if (p.url !== undefined) {
            if (typeof p.url !== "string" || p.url.length > 8192) throw new HcpError("BAD_REQUEST", "Invalid URL");
            let url: URL;
            try { url = new URL(p.url); } catch { throw new HcpError("BAD_REQUEST", "Invalid URL"); }
            if (!["http:", "https:"].includes(url.protocol) && p.url !== "about:blank") throw new HcpError("BAD_REQUEST", "URL must use http or https, or be about:blank");
          }
          if (!deps.spawnAllowed()) throw new HcpError("RATE_LIMITED", "spawn rate limit exceeded");
          const url = typeof p.url === "string" ? p.url : undefined;
          const tileId = openTile(p.callerTile, p.frame, (ws) => ({
            id: mintId("tile-browser"), kind: "browser",
            label: `Browser #${nextOrdinal(ws.tiles.map((t) => t.label), (n) => `Browser #${n}`)}`,
            ...(url ? { url } : {}),
          }), { background: false });
          return { tileId };
        });
      case "tile.list": {
        // One frame, named the way spawn names one; a name no frame answers to is refused.
        const ws = layoutFor(p.callerTile);
        const only = p.frame ? frameFor(ws.frames, String(p.frame)) : undefined;
        if (p.frame && !only) throw new HcpError("NOT_FOUND", `no frame answers to "${String(p.frame)}"`);
        return listTiles({ frames: ws.frames, tiles: ws.tiles, frameOf: ws.frameOf ?? {}, names: ws.tileNames ?? {} }, factsOf(ws.tiles), only);
      }
      case "tile.list_frames": {
        const ws = layoutFor(p.callerTile);
        return { frames: listFrames({ frames: ws.frames, tiles: ws.tiles, frameOf: ws.frameOf ?? {} }) };
      }
      // `hive ctl view emit`: a named JSON event for the active view (protocol 1.3).
      case "view.emit": {
        const ev = parseEmit(p as Record<string, unknown>);
        if (!emitBucket.take()) throw new HcpError("RATE_LIMITED", `at most ${EMIT_RATE.perSecond} view events a second`);
        return await deps.callRenderer("view.emit", ev, RENDERER_TIMEOUT);
      }
      // Community view packages are scanned when the registry loads; `hive
      // views install|remove` calls this so a running app picks the change
      // up without a restart (the renderer re-reads both roots and updates
      // its registry — the switcher and ⌘E order follow, an active view that
      // vanished falls back to the canvas).
      case "views.rescan":
        return effect(call, { verb: method }, () => deps.callRenderer("views.rescan", {}, RENDERER_TIMEOUT));
      // `hive agents install|remove` calls this so a running app picks the change
      // up without a restart. The renderer owns the workspace root, so it runs
      // the scan (through main, which refreshes its own catalog on the way).
      case "agents.rescan":
        return effect(call, { verb: method }, () => deps.callRenderer("agents.rescan", {}, RENDERER_TIMEOUT));
      // `hive config set` / `hive theme use` edited settings.json: re-read it
      // and push the result to the renderer (main owns the file while running).
      case "settings.reload":
        return effect(call, { verb: method }, () => deps.reloadSettings());
      case "tile.rename":
        return effect(call, { verb: method, target: tileOf(p.tileId) }, async () => {
          // The name every surface shows, and the one main's messages call the tile by.
          const tileId = bareOf(String(p.tileId ?? ""));
          if (!tileId) throw new HcpError("BAD_REQUEST", "tileId required");
          const name = cleanName(typeof p.name === "string" ? p.name : "");
          if (deps.workspaces.renameTile(tileId, name, CONTROL) === null) throw new HcpError("TILE_NOT_FOUND", `no open workspace has tile ${tileId}`);
          return { ok: true, name };
        });

      case "tile.focus": {
        if (!p.tileId) throw new HcpError("BAD_REQUEST", "tileId required");
        return await deps.callRenderer("tile.focus", { tileId: p.tileId }, RENDERER_TIMEOUT);
      }
      case "tile.close":
        return effect(call, { verb: method, target: tileOf(p.tileId) }, async () => {
          if (!p.tileId) throw new HcpError("BAD_REQUEST", "tileId required");
          // closeTile drops ALL per-tile state (pipes/turns/recorder/epochs/parent/
          // depth/supervision) + resolves any in-flight approvals for the worker.
          return await closeTile(String(p.tileId));
        });

      case "review.open":
        // Open a plan-review tile and BLOCK until the human decides. The
        // renderer doesn't reply on open — the tile resolves this caller via
        // hcpResult on the decision, which is why the timeout is generous. The decision it
        // comes back with is recorded.
        const decided = (r: unknown) => {
          const decision = (r as { decision?: unknown } | null)?.decision;
          return decision === "allow" || decision === "deny" ? decision : undefined;
        };
        return effect(call, { verb: method, detail: decided }, async () => {
          if (!p.plan) throw new HcpError("BAD_REQUEST", "plan required");
          return await deps.callRenderer("review.open", { plan: p.plan, cwd: p.cwd ?? "" }, REVIEW_TIMEOUT);
        });

      // ── pipes (main) ─────────────────────────────────────────────────────
      case "tile.connect":
        return effect(call, { verb: method, target: pipeOf(p.srcTileId, p.dstTileId) }, async () => {
          const src = String(p.srcTileId ?? "");
          const dst = String(p.dstTileId ?? "");
          if (!src || !dst) throw new HcpError("BAD_REQUEST", "srcTileId and dstTileId required");
          if (!deps.connect(src, dst)) throw new HcpError("BAD_REQUEST", "cannot pipe a tile to itself or create a cycle");
          return { ok: true };
        });
      case "tile.disconnect":
        return effect(call, { verb: method, target: pipeOf(p.srcTileId, p.dstTileId) }, async () => {
          const src = String(p.srcTileId ?? "");
          if (!src) throw new HcpError("BAD_REQUEST", "srcTileId required");
          deps.disconnect(src, p.dstTileId ? String(p.dstTileId) : undefined);
          return { ok: true };
        });

      default:
        throw new HcpError("UNKNOWN_METHOD", `unknown method: ${method}`);
    }
  };

  return { dispatch, forgetTile: forgetTileState, labelOf: label, spawn: doSpawn, close: closeTile };
}
