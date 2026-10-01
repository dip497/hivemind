/**
 * The control plane a machine runs for the agents in its workspaces (`hive ctl`, design R5, R7):
 * what it keeps of them — each session's output (the recorder), its turns and replies, its status,
 * the pipes between agents and who spawned whom, the messages waiting for an agent to be back at
 * its prompt — the events their hooks, a machine's daemon or another device send, and the verbs,
 * served on the control-plane socket (`listen`). The desktop app and `hive host` each make one,
 * with what only they have (`ControlPlaneOptions.methods`: a window to ask, the settings, the
 * store, sessions to end); the plane is the one owner of the rest. It keeps output, turns and
 * statuses from the moment it is made; its verbs are made with their first use.
 */
import path from "node:path";
import { AGENT_EVENT_METHOD, cleanName, parseAgentEvent } from "@hivemind/agents";
import { TILE_SESSIONS_DIR, writeTrackedSession } from "@hivemind/agents/node";
import { SUBMIT_DELAY_MS } from "@hivemind/agent-host/agent-io";
import { holderOf, readOrCreateToken } from "@hivemind/agent-host/hooks/token";
import { StatusStore, isSessionStatus, type ScreenState } from "@hivemind/agent-host/status-store";
import { toBareId, toPtyId } from "@hivemind/workspace-api/tile-id";
import type { WorkspaceServer } from "@hivemind/workspace-api/server";
import { startHcpServer, type HcpServer } from "./hcp-server.js";
import { Mailbox } from "./mailbox.js";
import { makeDispatch, type Dispatcher, type MethodDeps } from "./methods.js";
import { OutputRecorder } from "./output-recorder.js";
import { PipeManager } from "./pipes.js";
import type { HcpCall } from "./protocol.js";
import { SubagentReaper } from "./subagent-reaper.js";
import { TurnTracker } from "./turn-tracker.js";

/** The verbs' dependencies that only the embedder has; the plane provides the rest. */
export type EmbedderDeps = Omit<
  MethodDeps,
  | "agentOf" | "writeToTile" | "deliverToTile" | "turns" | "recorder" | "spawnAllowed" | "connect" | "disconnect"
  | "forgetPipes" | "spawnEdge" | "setSupervise" | "awaitingApproval" | "status" | "announceSpawn"
>;

export interface ControlPlaneOptions {
  /** This machine's data folder: the token the person and each agent hold, and the session each
   *  agent last reported (`tile-sessions`). */
  dir(): string;
  /** Tell every client of the workspace API: statuses, pipes, spawn wires, tiles opened. */
  publish: WorkspaceServer["publish"];
  /** Write to a tile's session at once (by its pty id); false when it has none here. */
  write(ptyId: string, data: string, paste?: boolean): boolean;
  /** A tile the control plane spawned, written to its workspace: the embedder lays it out (a
   *  window) or starts it (a host). Every client has been told of it. */
  spawned(spawn: { tileId: string; repo: string; prompt?: string; background: boolean }): void;
  /** Asked once, when the first verb comes or the socket opens. */
  methods(): EmbedderDeps;
  /** Whether a window is open to carry out a verb that needs one. */
  windowsUp(): boolean;
  /** What every verb waits for first (the app's agent scan). */
  ready?(): Promise<void>;
  /** A line worth keeping in a diagnostic log. */
  diag?(line: string): void;
}

/** A lost SubagentStop (the subagent errored, the turn was interrupted, the session compacted)
 *  would pin a tile's subagents forever: once the last subagent edge is this old, the plane
 *  reports the rest stopped. Every edge pushes the deadline out. */
const SUBAGENT_REAP_MS = 120_000;
/** Anti-fork-bomb: at most this many control-plane spawns a minute. */
const SPAWNS_A_MINUTE = 16;
const SCREEN_STATES = new Set<ScreenState>(["idle", "working", "permission", "question", "blocked"]);

export class ControlPlane {
  /** Each session's output, ANSI stripped, by pty id: what `read` and `stream` catch up from. */
  readonly recorder = new OutputRecorder();
  /** Each agent's turns and its replies, by pty id. */
  readonly turns = new TurnTracker();
  /** Every agent session's status, by bare tile id: hooks first, the screen for agents without
   *  them, exits and interrupt keys observed here. */
  readonly status = new StatusStore();
  /** Which agent runs in each tile (bare id → provider id), as it was started. */
  readonly agentOf = new Map<string, string>();
  /** Each supervised worker's policy (bare id → "all" or a tool list), injected as HIVE_SUPERVISE
   *  into its environment when its session starts. */
  readonly supervise = new Map<string, string>();
  /** Messages to an agent, held until it is at its prompt (by pty id). */
  readonly mailbox: Mailbox;
  private readonly pipes = new PipeManager();
  /** Spawn wires drawn now (child → parent): what a client that opens late draws. */
  private readonly spawnWires = new Map<string, string>();
  /** Tiles the control plane spawned whose session nobody has started yet. */
  private readonly unstarted = new Set<string>();
  private readonly reaper: SubagentReaper;
  private made: Dispatcher | null = null;
  private server: HcpServer | null = null;
  private spawnTimes: number[] = [];

  constructor(private readonly o: ControlPlaneOptions) {
    this.status.subscribe((change) => o.publish("status.changed", change));
    this.reaper = new SubagentReaper(SUBAGENT_REAP_MS, (tileId) => {
      const left = this.status.get(tileId)?.subagents ?? [];
      for (const agentId of left) this.status.event(tileId, { event: "subagent.stopped", agentId });
      if (left.length) o.diag?.(`[subagent-reap] tile=${tileId} drained ${left.length} ${SUBAGENT_REAP_MS}ms after the last edge`);
    });
    this.mailbox = new Mailbox(o.write, SUBMIT_DELAY_MS);
  }

  /** The verbs, made with the embedder's dependencies the first time they are wanted. */
  private get dispatcher(): Dispatcher {
    if (this.made) return this.made;
    const o = this.o;
    const pipe = (src: string, dst: string | null, connected: boolean) => o.publish("link.pipe", { src, dst, connected });
    this.made = makeDispatch({
      ...o.methods(),
      agentOf: (bare) => this.agentOf.get(bare),
      writeToTile: o.write,
      deliverToTile: (ptyId, text, onSent) => this.mailbox.deliver(ptyId, text, onSent),
      turns: this.turns,
      recorder: this.recorder,
      spawnAllowed: () => this.spawnAllowed(),
      connect: (src, dst) => { const ok = this.pipes.connect(src, dst); if (ok) pipe(src, dst, true); return ok; },
      disconnect: (src, dst) => { this.pipes.disconnect(src, dst); pipe(src, dst ?? null, false); },
      forgetPipes: (id) => { this.pipes.forget(id); pipe(id, null, false); },
      spawnEdge: (child, parent, connected) => {
        // Kept for a client that opens late; a drop takes every wire touching `child`.
        if (connected && parent) this.spawnWires.set(child, parent);
        else for (const [c, p] of this.spawnWires) if (c === child || p === child) this.spawnWires.delete(c);
        o.publish("link.spawn", { child, parent, connected });
      },
      setSupervise: (id, spec) => { if (spec) this.supervise.set(id, spec); else this.supervise.delete(id); },
      awaitingApproval: (tileId, waiting) =>
        this.status.event(tileId, waiting ? { event: "input.requested", kind: "approval" } : { event: "input.resolved" }),
      status: this.status,
      announceSpawn: (spawn) => {
        this.unstarted.add(spawn.tileId);
        o.publish("tile.opened", spawn);
        o.spawned(spawn);
      },
    });
    return this.made;
  }

  /** Carry out one verb, made by `call.actor`. */
  dispatch(method: string, params: unknown, call: HcpCall): Promise<unknown> {
    return (this.o.ready?.() ?? Promise.resolve()).then(() => this.dispatcher.dispatch(method, params, call));
  }

  /** What the control plane's messages call a tile. */
  labelOf(tileId: string): string {
    return this.dispatcher.labelOf(tileId);
  }

  /** Whether starting the session of `bare` is the control plane's doing (it spawned the tile),
   *  not the opener's; answered once. */
  takeSpawned(bare: string): boolean {
    return this.unstarted.delete(bare);
  }

  /** The pipes between agents and the spawn wires drawn now, for a client that opens late. */
  links(): { pipes: Array<{ src: string; dst: string }>; spawns: Array<{ parent: string; child: string }> } {
    return {
      pipes: this.pipes.edges().map(([src, dst]) => ({ src, dst })),
      spawns: [...this.spawnWires].map(([child, parent]) => ({ parent, child })),
    };
  }

  /** A session's output as it comes (by bare tile id): to whoever streams it. */
  output(bare: string, chunk: string): void {
    this.server?.broadcast(bare, chunk);
  }

  /** The session of `tileId` ended (crash, kill, a close): everything kept for it goes, and
   *  whatever waits on it (a parent's read, an approval) is answered now. */
  exited(tileId: string): void {
    const bare = toBareId(tileId);
    this.reaper.cancel(bare);
    this.mailbox.forget(toPtyId(tileId));
    this.status.exited(bare);
    this.made?.forgetTile(tileId);
  }

  /** The tile `tileId` is gone for good: nothing more is asked of its status or its agent. */
  forget(tileId: string): void {
    const bare = toBareId(tileId);
    this.unstarted.delete(bare);
    this.status.forget(bare);
    this.agentOf.delete(bare);
  }

  /** An event from a machine's daemon (here or another device's, R6): a session's status as it
   *  keeps it, or anything its hooks sent. */
  fromMachine(topic: string, data: unknown): void {
    if (topic !== "agent.status") return this.event(topic, data);
    const r = data as { tileId?: unknown; status?: unknown };
    if (typeof r.tileId === "string" && isSessionStatus(r.status)) this.status.mirror(toBareId(r.tileId), r.status);
  }

  /** An event an agent's hook sent, or what a host read of it: its window title, its screen's
   *  state, a reply. */
  event(method: string, params: unknown): void {
    if (method === "agent.title") {
      // A host read an agent's window title: what it says it is doing ("" = nothing).
      const r = (params ?? {}) as { tileId?: string; title?: unknown };
      if (r.tileId && typeof r.title === "string") this.status.title(toBareId(r.tileId), cleanName(r.title));
      return;
    }
    if (method === "agent.screen") {
      // A daemon read an agent's screen: its status until the agent's hooks report.
      const r = (params ?? {}) as { tileId?: string; state?: ScreenState };
      if (r.tileId && r.state && SCREEN_STATES.has(r.state)) this.status.screen(toBareId(r.tileId), r.state);
      return;
    }
    if (method === "agent.reply") {
      // A remote machine's daemon passes its hooks' replies on as this notification.
      const r = (params ?? {}) as { tileId?: string; text?: string };
      if (r.tileId && typeof r.text === "string" && r.text) this.turns.recordReply(toPtyId(r.tileId), r.text);
      return;
    }
    if (method !== AGENT_EVENT_METHOD) return;
    const evt = parseAgentEvent(params);
    if (!evt) return;
    // The session an agent reports from is the one its tile resumes.
    if (evt.sessionId) try { writeTrackedSession(path.join(this.o.dir(), TILE_SESSIONS_DIR), evt.tileId, evt.sessionId); } catch { /* best-effort */ }
    const bare = toBareId(evt.tileId);
    const pid = toPtyId(evt.tileId);
    this.status.event(bare, evt);
    if (evt.event === "subagent.started" || evt.event === "subagent.stopped" || evt.event === "turn.ended") {
      // Re-arm the lost-edge watchdog while subagents run; cancel it once they drain.
      if (this.status.get(bare)?.subagents.length) this.reaper.arm(bare);
      else this.reaper.cancel(bare);
    }
    // Hold agent-to-agent messages while this tile is mid-turn (its TUI would swallow them),
    // release one at its prompt.
    if (evt.event === "turn.started") { this.mailbox.setBusy(pid); return; }
    if (evt.event !== "turn.ended") return;
    // Single-delivery ladder: true if this reply was already delivered by a more specific channel
    // — a blocking agent.read (hive ctl read) took it, or the worker authored an explicit
    // agent.report this turn. Either way the auto-report below stands down, so the parent isn't
    // handed the same reply twice.
    const deliveredElsewhere = this.turns.recordTurn(pid);
    this.mailbox.setIdle(pid);
    // Pipe forwarding: feed this agent's reply into any piped destinations.
    const dests = this.pipes.dests(bare);
    if (dests.length === 0 || deliveredElsewhere) return;
    const reply = (this.turns.lastReply(pid) ?? "").trim();
    if (!reply) return;
    // Tag the forward with its source so the receiving agent knows which worker reported. The
    // mailbox holds it until the destination is back at its prompt.
    const banner = `\n[hive] from ${this.dispatcher.labelOf(bare)}:\n${reply}\n`;
    for (const dst of dests) this.mailbox.deliver(toPtyId(dst), banner);
  }

  /**
   * Serve the verbs on the control-plane socket `sock`: the person holds this machine's token,
   * each agent its tile's (hooks/token.ts). `onError` hears a socket that could not be opened.
   */
  listen(sock: string, onError?: (err: Error) => void): HcpServer {
    const token = readOrCreateToken(this.o.dir());
    this.server = startHcpServer(sock, {
      authenticate: (t) => {
        const holder = holderOf(token, t);
        return !holder ? null : "tile" in holder ? { kind: "tile", tile: toBareId(holder.tile) } : { kind: "person" };
      },
      ...(onError ? { onListenError: onError } : {}),
      rendererUp: () => this.o.windowsUp(),
      dispatch: (method, params, call) => this.dispatch(method, params, call),
      // Stream replay/resume for `hive ctl stream --lines/--since`: the recorder is keyed by pty
      // id, subscriptions by bare tile id.
      replay: (tileId, opts) =>
        typeof opts.lines === "number" ? this.recorder.tail(toPtyId(tileId), opts.lines) : this.recorder.since(toPtyId(tileId), opts.since ?? 0),
      offsetOf: (tileId) => this.recorder.mark(toPtyId(tileId)),
      status: this.status,
      onEvent: (method, params) => this.event(method, params),
    });
    return this.server;
  }

  private spawnAllowed(): boolean {
    const now = Date.now();
    this.spawnTimes = this.spawnTimes.filter((t) => now - t < 60_000);
    if (this.spawnTimes.length >= SPAWNS_A_MINUTE) return false;
    this.spawnTimes.push(now);
    return true;
  }
}
