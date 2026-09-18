/**
 * HCP verb dispatch. Splits work by where it must run:
 *   - RENDERER verbs (tile.spawn_agent) delegate to `deps.callRenderer` — the
 *     request-id-correlated main→renderer channel (the plan-bridge pattern).
 *   - MAIN verbs (agent.send, agent.read) run here: send writes to the pty;
 *     read awaits the next Stop-hook turn and returns the transcript reply, with
 *     a buffered-output timeout fallback.
 *
 * Phase 1 surface: tile.spawn_agent, agent.send, agent.read. (tile.list/focus/
 * close, agent.status/stream, review.open, issue.* land in later phases.)
 */
import { randomUUID } from "node:crypto";
import { HcpError } from "./protocol.js";
import type { TurnTracker } from "./turn-tracker.js";
import type { OutputRecorder } from "./output-recorder.js";
import { readLastAssistantMessage } from "./transcript.js";
import { toPtyId as ptyId, toBareId as bareOf } from "../../shared/tile-id.js";
import { setName, labelOf } from "./names.js";
import { agentById, agentOption, spawnableAgents, workerAgents, type AgentProviderDef } from "@hivemind/agents";
import { BROWSER_TOOL_ID, tileKindAvailability } from "@hivemind/core/tool-plugins";
import type { ToolsSettings } from "@hivemind/core/settings-schema";
import { SUBMIT_DELAY_MS } from "../../shared/agent-io.js";

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

/** Symbolic key → terminal bytes, for driving a worker's TUI (e.g. answering a
 *  native AskUserQuestion picker). A raw ESC byte can't be expressed through a
 *  plain-text param from a tool call, so agent.send_keys maps tokens here; any
 *  unknown token is sent as literal text (so digits / words type themselves). */
const KEYMAP: Record<string, string> = {
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  enter: "\r", return: "\r", esc: "\x1b", escape: "\x1b",
  tab: "\t", space: " ", backspace: "\x7f", del: "\x1b[3~", delete: "\x1b[3~",
  home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~",
};
/** Gap between successive keys, so a TUI registers each (e.g. arrow THEN enter)
 *  rather than processing a bundled write at once — mirrors SUBMIT_DELAY_MS. */
const KEY_GAP_MS = 40;

/** Tools where a plain `allow` is remembered for the rest of that worker's life
 *  (see `agent.approve`). File-touching tools only — approving them one call at a
 *  time is pure friction. Bash is deliberately ABSENT: each command is a distinct
 *  action, so a cached allow there would be a blanket shell. Names are lowercased
 *  before lookup — claude says "Edit"/"Write", pi says "edit"/"write". */
const STICKY_ALLOW = new Set(["edit", "write", "read", "multiedit", "notebookedit", "webfetch"]);

/** Whether a plain `allow` on this approveCache key (`<worker>:<tool>`) should be
 *  remembered. The worker id contains no ":" (it's `tile-<kind>-<ts>`), so the tool
 *  is the last segment; case is normalized (claude "Edit" vs pi "edit"). */
export function stickyAllow(cacheKey: string): boolean {
  return STICKY_ALLOW.has((cacheKey.split(":").pop() ?? "").toLowerCase());
}

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
  pushWait: (tileId: string, status: string | null) => void;
}

const RENDERER_TIMEOUT = 15_000;
const DEFAULT_READ_TIMEOUT = 120_000;
const REVIEW_TIMEOUT = 24 * 60 * 60 * 1000; // human review may take a long time

export interface Dispatcher {
  /** Handle one HCP method call. */
  dispatch: (method: string, params: unknown) => Promise<unknown>;
  /** Drop ALL per-tile HCP state for a tile that has gone away, WITHOUT the
   *  renderer round-trip `tile.close` does. MUST be called on every pty-exit and
   *  user-close path — otherwise the maps (parentOf/depthOf/sendSeq/approveCache/
   *  pendingApprovals) leak, a blocked agent.read/approval on the dead worker hangs
   *  its full timeout instead of resolving, and its UI "awaiting" status lingers.
   *  Idempotent — safe to call twice (e.g. tile.close then the resulting pty-exit). */
  forgetTile: (tileId: string) => void;
}

export function makeDispatch(deps: MethodDeps): Dispatcher {
  // Per-tile read epoch: set at spawn/send so agent.read waits for the turn that
  // FOLLOWS the prompt we just delivered (not a stale earlier turn).
  const sendSeq = new Map<string, number>();
  const sendMark = new Map<string, number>();

  // Bare↔pty id mapping lives in shared/tile-id (imported as ptyId/bareOf). The
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
  const pendingApprovals = new Map<string, { resolve: (d: { decision: "allow" | "deny"; reason?: string }) => void; timer: ReturnType<typeof setTimeout>; cacheKey: string; worker: string }>();
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
    callerTile?: unknown; report?: unknown; supervise?: unknown; name?: unknown;
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
    const mode = opts.mode != null ? opts.mode : sup ? undefined : agentOption(def, "mode")?.unattended;
    // A spawner-chosen display name ("reviewer", "test-writer") — becomes the tile
    // label and tags every message this worker sends back. Bounded so a worker
    // can't smuggle a whole paragraph (or ANSI) into the parent's terminal banner.
    const name = typeof opts.name === "string" ? opts.name.replace(/[\p{C}]/gu, "").trim().slice(0, 40) : "";
    const res = (await deps.callRenderer(
      "tile.spawn_agent",
      // `background` = a silent worker (report:false → gathered in bulk, e.g. a
      // workflow worker). The renderer uses it to NOT steal focus / center the
      // viewport on spawn and to suppress the per-worker "finished" notification.
      { agent, prompt: opts.prompt, frame: opts.frame, mode, model: opts.model, callerTile: opts.callerTile, background: opts.report === false, name: name || undefined },
      RENDERER_TIMEOUT,
    )) as { tileId?: string };
    if (!res?.tileId) throw new HcpError("INTERNAL", "spawn returned no tileId");
    depthOf.set(res.tileId, childDepth);
    agentOfTile.set(res.tileId, agent);
    if (name) setName(res.tileId, name);
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
    setName(bare, null);
    deps.setSupervise(bare, null);
    for (const [reqId, pend] of pendingApprovals) {
      if (pend.cacheKey.startsWith(`${bare}:`)) {
        clearTimeout(pend.timer);
        pend.resolve({ decision: "deny", reason: "worker closed" });
        pendingApprovals.delete(reqId);
      }
    }
    for (const key of approveCache.keys()) if (key.startsWith(`${bare}:`)) approveCache.delete(key);
    deps.pushWait(bare, null);
  };

  // Close a tile: ask the renderer to remove it, then drop its state. Shared by the
  // `tile.close` verb and workflow's `close_when_done`.
  const closeTile = async (tileId: string): Promise<unknown> => {
    const r = await deps.callRenderer("tile.close", { tileId }, RENDERER_TIMEOUT);
    forgetTileState(tileId);
    return r;
  };

  const dispatch = async (method: string, rawParams: unknown): Promise<unknown> => {
    const p = (rawParams ?? {}) as Record<string, unknown>;
    switch (method) {
      case "tile.spawn_agent": {
        // Anti-fork-bomb depth + rate gates, parent/auto-report/supervision
        // wiring, and the read-epoch arm all live in doSpawn (shared with
        // workflow.run). AUTO-REPORT is on unless report:false; the read epoch is
        // armed so a follow-up agent.read waits for THIS agent's first turn.
        const tileId = await doSpawn({
          agent: p.agent, name: p.name, prompt: p.prompt, frame: p.frame, mode: p.mode, model: p.model,
          callerTile: p.callerTile, report: p.report, supervise: p.supervise,
        });
        return { tileId };
      }

      case "agent.send": {
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
      }

      case "agent.send_keys": {
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
        const bytesOf = (k: string) => KEYMAP[k.toLowerCase()] ?? k;
        const ok = deps.writeToTile(pid, bytesOf(keys[0]!));
        if (!ok) throw new HcpError("TILE_NOT_FOUND", `no live agent for tile ${tileId}`);
        for (let i = 1; i < keys.length; i++) {
          const b = bytesOf(keys[i]!);
          setTimeout(() => deps.writeToTile(pid, b), KEY_GAP_MS * i);
        }
        return { ok: true, keys: keys.length };
      }

      case "agent.report": {
        // A spawned worker pushes a result back to the agent that spawned it.
        // The caller passes its OWN tile id (HIVEMIND_TILE); we look up its
        // parent and deliver the message into the parent's terminal (typed +
        // Enter, like agent.send) so the parent reads it on its next turn.
        const child = bareOf(String(p.callerTile ?? ""));
        const parent = parentOf.get(child);
        if (!parent) throw new HcpError("TILE_NOT_FOUND", "no parent agent to report to");
        const message = String(p.message ?? "").trim();
        if (!message) throw new HcpError("BAD_REQUEST", "message required");
        const banner = `\n[hive] report from ${labelOf(child)}:\n${message}\n`;
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
        const inp = (p.tool_input ?? {}) as Record<string, unknown>;
        const reqId = randomUUID();
        const summary = summarizeTool(tool, inp);
        const banner =
          `\n[hive] APPROVAL — worker ${labelOf(worker)} wants to run ${tool}: ${summary}\n` +
          `Reply: hive ctl approve ${reqId} allow|deny|always|never\n`;
        // Surface the pause in the UI: this worker is now waiting on its parent.
        deps.pushWait(worker, "awaiting_approval");
        return await new Promise((resolve) => {
          const done = (decision: "ask") => {
            const pend = pendingApprovals.get(reqId);
            if (pend) clearTimeout(pend.timer);
            pendingApprovals.delete(reqId);
            deps.pushWait(worker, null);
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
          pendingApprovals.set(reqId, { resolve, timer: ceiling, cacheKey, worker });
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
      }

      case "agent.approve": {
        // The supervising agent answers an approval request (by reqId). always /
        // never also remember the decision for this worker+tool (no more
        // round-trips for it).
        const reqId = String(p.reqId ?? "");
        const decision = String(p.decision ?? "");
        const reason = p.reason != null ? String(p.reason) : undefined;
        const pend = pendingApprovals.get(reqId);
        if (!pend) throw new HcpError("BAD_REQUEST", `no pending approval ${reqId} (expired or already answered)`);
        let d: "allow" | "deny";
        if (decision === "allow" || decision === "always") d = "allow";
        else if (decision === "deny" || decision === "never") d = "deny";
        else throw new HcpError("BAD_REQUEST", "decision must be allow | deny | always | never");
        if (decision === "always") approveCache.set(pend.cacheKey, "allow");
        if (decision === "never") approveCache.set(pend.cacheKey, "deny");
        // A plain `allow` STICKS for the file-touching tools. Approving "edit" once
        // and then being re-asked on every subsequent edit stalls the worker ~9min
        // per file and burns a parent turn each time — the supervisor ends up
        // rubber-stamping, which is worse than not supervising at all.
        // BASH IS EXEMPT: every command is a different action ("ls" ≠ "rm -rf /"),
        // so caching an allow there would hand the worker a blanket shell. Bash
        // (and anything else) still re-asks unless the parent says `always`.
        if (decision === "allow" && stickyAllow(pend.cacheKey)) {
          approveCache.set(pend.cacheKey, "allow");
        }
        clearTimeout(pend.timer);
        pendingApprovals.delete(reqId);
        deps.pushWait(pend.worker, null); // resolved → clear the "waiting" status
        pend.resolve({ decision: d, reason });
        return { ok: true, decision: d };
      }

      case "agent.read": {
        const tileId = String(p.tileId ?? "");
        if (!tileId) throw new HcpError("BAD_REQUEST", "tileId required");
        requireTurnSignal(tileId, "agent.read");
        const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_READ_TIMEOUT;
        const pid = ptyId(tileId);
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
        if (rec && typeof rec.text === "string" && rec.text.length > 0) {
          // pi inline-reply path: pi has no transcript file — its lifecycle-bridge
          // extension carries the finished reply on the turn event itself.
          return { text: rec.text, finalStatus: "turn", truncated: false };
        }
        if (rec?.transcriptPath) {
          // Clean reply from the session transcript JSONL (NOT screen-scrape).
          // The Stop hook can fire a beat before the assistant's final message is
          // flushed to the transcript file, so a first read returns null on a
          // genuinely-completed turn (the observed `text:null` + finalStatus:turn).
          // Retry a few times over ~0.5s to let the flush land before giving up.
          let text = readLastAssistantMessage(rec.transcriptPath);
          for (let i = 0; text == null && i < 4; i++) {
            await new Promise<void>((r) => { const t = setTimeout(r, 130); t.unref?.(); });
            text = readLastAssistantMessage(rec.transcriptPath);
          }
          if (text != null) return { text, finalStatus: "turn", truncated: false };
          return { text: null, finalStatus: "turn", truncated: false, note: "turn completed but its transcript was unreadable" };
        }
        if (rec) return { text: null, finalStatus: "turn", truncated: false, note: "turn completed but carried no readable reply" };
        // No completed turn within the timeout. Report status honestly instead of
        // scraping the raw ANSI terminal buffer (which returned garbled bytes, not
        // the agent's words). The agent is still working; if it was spawned with
        // report:true it will auto-deliver its reply to the parent when done.
        return { text: null, finalStatus: "timeout", truncated: false, note: "agent still working — no completed turn within timeout" };
      }

      case "workflow.run": {
        // Multi-agent orchestration. Fan a list of items out to visible worker
        // tiles (or chain them as a pipeline), await each worker's turn
        // deterministically via the turn-tracker (NOT screen-scrape), and return
        // the aggregated transcript replies. Workers are spawned report:false —
        // the workflow gathers them itself, so their replies don't also spam the
        // orchestrator's terminal. The orchestrator's `hive ctl workflow` call blocks until
        // this returns (`hive ctl workflow` blocks with a matching client ceiling).
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
        // turn, read the clean transcript reply. Returns a per-worker result.
        type WR = { item: string; tileId: string | null; status: "turn" | "timeout" | "error"; text: string | null };
        const runWorker = async (label: string, prompt: string): Promise<WR> => {
          let tileId: string;
          try {
            tileId = await spawnRetry({ agent, prompt, frame, model, callerTile: caller, report: false, supervise, name: label });
          } catch (e) {
            return { item: label, tileId: null, status: "error", text: (e as Error).message };
          }
          const pid = ptyId(tileId);
          const afterSeq = sendSeq.get(pid) ?? deps.turns.currentSeq(pid);
          const rec = await deps.turns.waitForTurn(pid, afterSeq, perTurnMs);
          // Same two carriers agent.read handles: an inline reply (pi's bridge sends the
          // text on the turn event) or a transcript path (claude/droid).
          const text = rec?.text && rec.text.length > 0
            ? rec.text
            : rec?.transcriptPath ? readLastAssistantMessage(rec.transcriptPath) : null;
          const status: WR["status"] = !rec ? "timeout" : rec.seq === -1 ? "error" : "turn";
          if (closeWhenDone && status === "turn") { try { await closeTile(tileId); } catch { /* best-effort */ } }
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
      }

      // ── canvas verbs (renderer) ──────────────────────────────────────────
      case "tool.open": {
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
        return await deps.callRenderer("tool.open", { tool: p.tool, frame: p.frame, url: p.url }, RENDERER_TIMEOUT);
      }
      case "tile.list":
        return await deps.callRenderer("tile.list", { frame: p.frame }, RENDERER_TIMEOUT);
      case "tile.list_frames":
        return await deps.callRenderer("tile.list_frames", {}, RENDERER_TIMEOUT);
      // Community view packages are scanned when the registry loads; `hive
      // views install|remove` calls this so a running app picks the change
      // up without a restart (the renderer re-reads both roots and updates
      // its registry — the switcher and ⌘E order follow, an active view that
      // vanished falls back to the canvas).
      case "views.rescan":
        return await deps.callRenderer("views.rescan", {}, RENDERER_TIMEOUT);
      // `hive agents install|remove` calls this so a running app picks the change
      // up without a restart. The renderer owns the workspace root, so it runs
      // the scan (through main, which refreshes its own catalog on the way).
      case "agents.rescan":
        return await deps.callRenderer("agents.rescan", {}, RENDERER_TIMEOUT);
      // `hive config set` / `hive theme use` edited settings.json: re-read it
      // and push the result to the renderer (main owns the file while running).
      case "settings.reload":
        return await deps.reloadSettings();
      case "tile.focus": {
        if (!p.tileId) throw new HcpError("BAD_REQUEST", "tileId required");
        return await deps.callRenderer("tile.focus", { tileId: p.tileId }, RENDERER_TIMEOUT);
      }
      case "tile.close": {
        if (!p.tileId) throw new HcpError("BAD_REQUEST", "tileId required");
        // closeTile drops ALL per-tile state (pipes/turns/recorder/epochs/parent/
        // depth/supervision) + resolves any in-flight approvals for the worker.
        return await closeTile(String(p.tileId));
      }

      case "review.open": {
        // Open a plan-review tile and BLOCK until the human decides. The
        // renderer doesn't reply on open — the tile resolves this caller via
        // hcpResult on the decision, which is why the timeout is generous.
        if (!p.plan) throw new HcpError("BAD_REQUEST", "plan required");
        return await deps.callRenderer("review.open", { plan: p.plan, cwd: p.cwd ?? "" }, REVIEW_TIMEOUT);
      }

      // ── pipes (main) ─────────────────────────────────────────────────────
      case "tile.connect": {
        const src = String(p.srcTileId ?? "");
        const dst = String(p.dstTileId ?? "");
        if (!src || !dst) throw new HcpError("BAD_REQUEST", "srcTileId and dstTileId required");
        if (!deps.connect(src, dst)) throw new HcpError("BAD_REQUEST", "cannot pipe a tile to itself or create a cycle");
        return { ok: true };
      }
      case "tile.disconnect": {
        const src = String(p.srcTileId ?? "");
        if (!src) throw new HcpError("BAD_REQUEST", "srcTileId required");
        deps.disconnect(src, p.dstTileId ? String(p.dstTileId) : undefined);
        return { ok: true };
      }

      default:
        throw new HcpError("UNKNOWN_METHOD", `unknown method: ${method}`);
    }
  };

  return { dispatch, forgetTile: forgetTileState };
}
