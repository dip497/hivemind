/**
 * The control plane a machine runs for the agents in its workspaces (`hive ctl`, design R5, R7):
 * what it keeps of them — each session's output (the recorder), its turns and replies, its status,
 * the pipes between agents and who spawned whom, the messages waiting for an agent to be back at
 * its prompt — the events their hooks, a machine's daemon or another device send, and what it
 * does: the agent channel, served on the control-plane socket (`listen`), and its part of the
 * workspace API (`api`). The desktop app and `hive host` each make one,
 * with what only they have (`ControlPlaneOptions.methods`: a window to ask, the settings, the
 * store, sessions to end); the plane is the one owner of the rest. It keeps output, turns and
 * statuses from the moment it is made; its verbs are made with their first use.
 */
import path from "node:path";
import { AGENT_EVENT_METHOD, cleanName, parseAgentEvent } from "@hivemind/agents";
import { TILE_SESSIONS_DIR, writeTrackedSession } from "@hivemind/agents/node";
import { SUBMIT_DELAY_MS } from "@hivemind/agent-host/agent-io";
import { KEY_GAP_MS } from "@hivemind/agent-host/keys";
import { hcpSockPath, holderOf, readOrCreateToken, speaksFor } from "@hivemind/agent-host/hooks/token";
import { StatusStore, isSessionStatus, type ScreenState } from "@hivemind/agent-host/status-store";
import { ControlRefused } from "@hivemind/agent-host/daemon-endpoint";
import { toBareId, toPtyId } from "@hivemind/workspace-api/tile-id";
import type { WorkspaceServer } from "@hivemind/workspace-api/server";
import type { AgentItem } from "@hivemind/workspace-api/agents";
import { startHcpServer, type HcpServer } from "./hcp-server.js";
import { Inbox } from "./inbox.js";
import { Mailbox } from "./mailbox.js";
import { makeDispatch, type ControlWork, type Dispatcher, type MethodDeps } from "./methods.js";
import { OutputRecorder } from "./output-recorder.js";
import { PipeManager } from "./pipes.js";
import { SpawnRecords } from "./spawn-records.js";
import type { HcpCall } from "./protocol.js";
import { SubagentReaper } from "./subagent-reaper.js";
import { TurnTracker } from "./turn-tracker.js";
import { Waits } from "../waits.js";
import { socketIn } from "../socket-in.js";

/** The verbs' dependencies that only the embedder has; the plane provides the rest. */
export type EmbedderDeps = Omit<
  MethodDeps,
  | "agentOf" | "writeToTile" | "deliverToTile" | "turns" | "recorder" | "spawnAllowed" | "connect" | "disconnect"
  | "forgetPipes" | "spawnEdge" | "spawnRecords" | "waits" | "status" | "announceSpawn" | "inbox" | "waitingOf" | "slept" | "woke"
>;

export interface ControlPlaneOptions {
  /** This machine's data folder: the token the person and each agent hold, and the session each
   *  agent last reported (`tile-sessions`). */
  dir(): string;
  /** Tell every client of the workspace API: statuses, pipes, spawn wires, tiles opened. */
  publish: WorkspaceServer["publish"];
  /** Write to a tile's session at once (by its pty id); false when it has none here. */
  write(ptyId: string, data: string, paste?: boolean): boolean;
  /** Whether a tile's agent reads a message typed while it works (its file says `steer`). */
  steers?(bareTile: string): boolean;
  /** Whether a tile's agent reports its turns (its file says `turnSignal`): only then is a turn
   *  its screen shows one whose end will be known. */
  signalsTurns?(bareTile: string): boolean;
  /** A tile the control plane spawned, written to its workspace: the embedder starts its session,
   *  with `prompt` its first task. Every client has been told of it, and lays it out. */
  spawned(spawn: { tileId: string; repo: string; prompt?: string; background: boolean }): void;
  /** Asked once, when the first verb comes or the socket opens. */
  methods(): EmbedderDeps;
  /** Whether a window is open to carry out a verb that needs one. */
  windowsUp(): boolean;
  /** What every verb waits for first (the app's agent scan). */
  ready?(): Promise<void>;
  /** A line worth keeping in a diagnostic log. */
  diag?(line: string): void;
  /** A wait began, ended, or its time to answer changed. */
  waitsChanged?(): void;
  /** A tile's screen showed another last line (`lines`). */
  lineChanged?(): void;
  /** What the agent of a tile waits on, as the person's devices are told it. */
  waitingOf?(bareTile: string): AgentItem["waiting"];
}

/** A lost SubagentStop (the subagent errored, the turn was interrupted, the session compacted)
 *  would pin a tile's subagents forever: once the last subagent edge is this old, the plane
 *  reports the rest stopped. Every edge pushes the deadline out. */
const SUBAGENT_REAP_MS = 120_000;
/** Anti-fork-bomb: at most this many control-plane spawns a minute by each tree of callers… */
const SPAWNS_A_MINUTE = 16;
/** …and this many by all of them. */
const SPAWNS_ALL_A_MINUTE = 64;
const SCREEN_STATES = new Set<ScreenState>(["idle", "working", "permission", "question", "blocked"]);
/** What an agent's terminal is told when messages wait in its inbox; never what they say. */
const DOORBELL = "\n[hive] Your agents sent you messages. Read them: hive ctl inbox\n";
/** Where the control plane keeps who started each tile it spawned, in its data folder. */
const SPAWN_RECORDS_FILE = "spawned-tiles.json";

export class ControlPlane {
  /** Each session's output, ANSI stripped, by pty id: what `read` and `stream` catch up from. */
  readonly recorder = new OutputRecorder();
  /** Each agent's turns and its replies, by pty id. */
  readonly turns = new TurnTracker();
  /** Every agent session's status, by bare tile id: hooks first, the screen for agents without
   *  them, exits and interrupt keys observed here. */
  readonly status = new StatusStore();
  /** What agents wait on that an answer ends: plans, supervised tool uses. */
  readonly waits: Waits;
  /** Which agent runs in each tile (bare id → provider id), as it was started. */
  readonly agentOf = new Map<string, string>();
  /** Who started each spawned tile and on what terms, kept across restarts. */
  private readonly spawnRecords: SpawnRecords;
  /** Each supervised worker's policy (bare id → "all" or a tool list), injected as HIVE_SUPERVISE
   *  into its environment when its session starts. */
  readonly supervise = { get: (bare: string): string | undefined => this.spawnRecords.get(bare)?.supervise };
  /** Messages to an agent, held until it is at its prompt (by pty id). */
  readonly mailbox: Mailbox;
  /** What other agents have for an agent, until it reads them (by bare id). */
  readonly inbox: Inbox;
  /** What each tile's screen last showed with text, by bare tile id, as its daemon read it. */
  readonly lines = new Map<string, string>();
  private readonly pipes = new PipeManager();
  /** Spawn links now (child → parent): what a client that opens late starts from. */
  private readonly spawnWires = new Map<string, string>();
  private readonly reaper: SubagentReaper;
  /** Terminals an answer's keys are going into, and the writes held until its last is in. */
  private readonly typing = new Map<string, Array<() => void>>();
  private made: Dispatcher | null = null;
  /** When each caller started what it started in the last minute, by caller. */
  private spawnTimes = new Map<string, number[]>();
  /** Tiles whose status says a turn is going (working, or waiting within it). */
  private readonly inTurn = new Set<string>();
  /** The session last written for each tile, by the id its hooks name it by. */
  private readonly recorded = new Map<string, string>();

  constructor(private readonly o: ControlPlaneOptions) {
    this.spawnRecords = new SpawnRecords(path.join(o.dir(), SPAWN_RECORDS_FILE));
    // The wires and report pipes of the workers this app spawned before it last stopped.
    for (const [child, r] of this.spawnRecords.entries()) {
      if (!r.spawner) continue;
      this.spawnWires.set(child, r.spawner);
      if (r.reports) this.pipes.connect(child, r.spawner);
    }
    this.waits = new Waits({ status: this.status, changed: () => o.waitsChanged?.() });
    this.status.subscribe((change) => o.publish("status.changed", change));
    // A spawned worker that starts waiting is reported to its parent; no dispatcher yet, no workers.
    this.status.subscribe((change) => this.made?.onStatus(change.tileId, change.status));
    this.reaper = new SubagentReaper(SUBAGENT_REAP_MS, (tileId) => {
      const left = this.status.get(tileId)?.subagents ?? [];
      for (const agentId of left) this.status.event(tileId, { event: "subagent.stopped", agentId });
      if (left.length) o.diag?.(`[subagent-reap] tile=${tileId} drained ${left.length} ${SUBAGENT_REAP_MS}ms after the last edge`);
    });
    this.mailbox = new Mailbox((ptyId, data, paste) => this.write(ptyId, data, paste), SUBMIT_DELAY_MS, (ptyId) => {
      // Waiting on a prompt of its own, a message typed there would answer it (Enter allows).
      const bare = toBareId(ptyId);
      return this.status.get(bare)?.state === "working" && (o.steers?.(bare) ?? false);
    });
    this.inbox = new Inbox((to, wanted, rung) => this.mailbox.deliver(toPtyId(to), DOORBELL, rung, { wanted, atPrompt: true }));
    // However a turn is known to run (its hook, or the screen of an agent that reports its turns:
    // one already running when this app started ran its hook before), messages wait for its end;
    // however it ends (its Stop hook, an interrupt key, a screen showing its prompt), what was held
    // goes out. An agent that reports none takes them at once, as a turn's end may never show.
    this.status.subscribe(({ tileId, status }) => {
      const now = status.state === "working" || status.state === "waiting";
      const was = this.inTurn.has(tileId);
      if (now) this.inTurn.add(tileId);
      else this.inTurn.delete(tileId);
      // A wait is in a turn, but does not start one: a startup screen (a folder's trust) answered
      // reads working with no turn to end, and would hold every message after it.
      if (status.state === "working" && !was && (o.signalsTurns?.(tileId) ?? false)) this.mailbox.setBusy(toPtyId(tileId));
      if (was && !now && status.state !== "exited") this.mailbox.setIdle(toPtyId(tileId));
      // An ended session's file goes with it (its daemon evicts it): the next one is written again.
      if (status.state === "exited") this.forgetRecorded(tileId);
    });
  }

  private forgetRecorded(bare: string): void {
    this.recorded.delete(bare);
    this.recorded.delete(toPtyId(bare));
  }

  /** A program's write (a message, a pipe, `hive ctl keys`): after the keys of an answer going in. */
  private write(ptyId: string, data: string, paste?: boolean): boolean {
    const after = this.typing.get(ptyId);
    if (!after) return this.o.write(ptyId, data, paste);
    after.push(() => this.o.write(ptyId, data, paste));
    return true;
  }

  /** The person typed `data` into the session of `ptyId`, at a window or from another of their
   *  devices: the agent's status and the mailbox are told, and it is written. False when no
   *  session is held for it. */
  typed(ptyId: string, data: string, paste = false): boolean {
    this.status.input(toBareId(ptyId), data);
    this.mailbox.typed(ptyId, data, paste);
    return this.o.write(ptyId, data, paste);
  }

  /** A key of an answer, typed as the person types, but no draft of theirs. */
  private key(ptyId: string, data: string): boolean {
    this.status.input(toBareId(ptyId), data);
    this.mailbox.typed(ptyId, data, false, true);
    return this.o.write(ptyId, data);
  }

  /** Answer as the person: type `parts`, the first now and each next one a moment after the
   *  last, so a screen takes each, holding the terminal until the last is in. False, typing
   *  nothing, while another answer is going in there, or when no session is held for it. */
  answer(ptyId: string, parts: readonly string[]): boolean {
    const [first, ...rest] = parts;
    if (first === undefined || this.typing.has(ptyId) || !this.key(ptyId, first)) return false;
    if (!rest.length) return true;
    const after: Array<() => void> = [];
    this.typing.set(ptyId, after);
    rest.forEach((bytes, i) => setTimeout(() => {
      this.key(ptyId, bytes);
      if (i < rest.length - 1) return;
      this.typing.delete(ptyId);
      for (const write of after) write();
    }, KEY_GAP_MS * (i + 1)));
    return true;
  }

  /** The verbs, made with the embedder's dependencies the first time they are wanted. */
  private get dispatcher(): Dispatcher {
    if (this.made) return this.made;
    const o = this.o;
    const pipe = (src: string, dst: string | null, connected: boolean) => o.publish("link.pipe", { src, dst, connected });
    this.made = makeDispatch({
      ...o.methods(),
      agentOf: (bare) => this.agentOf.get(bare),
      writeToTile: (ptyId, data) => this.write(ptyId, data),
      deliverToTile: (ptyId, text, onSent) => this.mailbox.deliver(ptyId, text, onSent),
      inbox: this.inbox,
      slept: (bare) => this.slept(bare),
      woke: (bare, ready) => this.woke(bare, ready),
      waitingOf: (bare) => o.waitingOf?.(bare),
      turns: this.turns,
      recorder: this.recorder,
      spawnAllowed: (by) => this.spawnAllowed(by),
      connect: (src, dst) => { const ok = this.pipes.connect(src, dst); if (ok) pipe(src, dst, true); return ok; },
      disconnect: (src, dst) => { this.pipes.disconnect(src, dst); pipe(src, dst ?? null, false); },
      forgetPipes: (id) => { this.pipes.forget(id); pipe(id, null, false); },
      spawnEdge: (child, parent, connected) => {
        // Kept for a client that opens late; a drop takes every wire touching `child`.
        if (connected && parent) this.spawnWires.set(child, parent);
        else for (const [c, p] of this.spawnWires) if (c === child || p === child) this.spawnWires.delete(c);
        o.publish("link.spawn", { child, parent, connected });
      },
      spawnRecords: this.spawnRecords,
      waits: this.waits,
      status: this.status,
      announceSpawn: ({ prompt, ...opened }) => {
        o.publish("tile.opened", opened);
        o.spawned({ ...opened, prompt });
      },
    });
    return this.made;
  }

  /** One call on the agent channel, made by `call.actor`. */
  agentChannel(method: string, params: unknown, call: HcpCall): Promise<unknown> {
    return (this.o.ready?.() ?? Promise.resolve()).then(() => this.dispatcher.agentChannel(method, params, call));
  }

  /** What the workspace API asks of the control plane (control-api.ts), once what it waits for
   *  is ready. The API records each effect. */
  async api(): Promise<ControlWork> {
    await this.o.ready?.();
    return this.dispatcher.api;
  }

  /** What the control plane's messages call a tile. */
  labelOf(tileId: string): string {
    return this.dispatcher.labelOf(tileId);
  }

  /** The tile asleep in a conversation that `args`, started in `tileId`, would resume: woken, it
   *  would write that conversation too. */
  conversationAsleep(tileId: string, args: readonly string[]): string | undefined {
    return this.dispatcher.conversationAsleep(tileId, args);
  }

  /** Start `program` (none: the person's default) in the workspace at `repo` for the person, from
   *  another of their devices (spec/agents.md "Starting"), a view on one (P8), a program, or an
   *  agent (`parent`): with its gates, and their saved options for it with these on top, never
   *  its unattended mode unless `mode` says so or an agent starts it; `name`, its tile's. Its
   *  tile. The caller records it. */
  async start(repo: string, start: {
    program?: string; frame?: string; prompt?: string; model?: string; mode?: string; name?: string; resume?: string;
    supervise?: string | true; report?: boolean; parent?: string;
  }): Promise<string> {
    await this.o.ready?.();
    const { program, ...rest } = start;
    return this.dispatcher.spawn({ agent: program, ...rest, repo });
  }

  /** Who started `bare` and hears its reports: a tile, or a program (`client:<grant id>`). */
  parentOf(bare: string): string | undefined {
    return this.made?.parentOf(bare);
  }

  /** Close `tile`: whether a workspace had it. The caller records it. */
  async close(tile: string): Promise<boolean> {
    await this.o.ready?.();
    try {
      await this.dispatcher.close(tile);
      return true;
    } catch (e) {
      if ((e as { code?: unknown }).code === "NOT_FOUND") return false;
      throw e;
    }
  }

  /** The pipes between agents and the spawn links now, for a client that opens late. */
  links(): { pipes: Array<{ src: string; dst: string }>; spawns: Array<{ parent: string; child: string }> } {
    return {
      pipes: this.pipes.edges().map(([src, dst]) => ({ src, dst })),
      spawns: [...this.spawnWires].map(([child, parent]) => ({ parent, child })),
    };
  }

  /** The session of `tileId` ended (crash, kill, a close): everything kept for that session goes,
   *  and whatever waits on it (a parent's read, an approval) is answered now. Who started it and
   *  whom it started stay until its tile is closed (`forget`): a restart is not a removal. */
  exited(tileId: string): void {
    const bare = toBareId(tileId);
    this.reaper.cancel(bare);
    this.mailbox.forget(toPtyId(tileId));
    this.inbox.forget(bare);
    this.inTurn.delete(bare);
    this.status.exited(bare);
    this.made?.sessionEnded(tileId);
  }

  /** The session of `tileId` was put to sleep: it runs nothing, but is not gone. A turn it was in is
   *  over; what was sent it, its inbox, its supervision and its pipes wait for it to wake. */
  slept(tileId: string): void {
    const bare = toBareId(tileId);
    this.mailbox.sleep(toPtyId(tileId));
    this.inTurn.delete(bare);
    this.status.slept(bare);
    this.made?.asleep(bare);
  }

  /** The session of `tileId` was woken: what waited for it is told once it is up; `ready` settles
   *  once its screen has. */
  woke(tileId: string, ready?: Promise<void>): void {
    const pty = toPtyId(tileId);
    this.mailbox.woke(pty);
    void ready?.then(() => this.mailbox.ready(pty));
    this.inbox.remind(toBareId(tileId));
  }

  /** The tile `tileId` is gone for good (closed): nothing more is asked of its status or its agent,
   *  and its pipes, spawn wires and who started it go. */
  forget(tileId: string): void {
    const bare = toBareId(tileId);
    this.status.forget(bare);
    this.agentOf.delete(bare);
    this.lines.delete(bare);
    this.forgetRecorded(bare);
    this.spawnRecords.forget(bare);
    if (this.made) this.made.forgetTile(tileId);
    else {
      this.pipes.forget(bare);
      for (const [child, parent] of this.spawnWires) if (child === bare || parent === bare) this.spawnWires.delete(child);
    }
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
    if (method === "tile.line") {
      const r = (params ?? {}) as { tileId?: unknown; line?: unknown };
      if (typeof r.tileId !== "string" || typeof r.line !== "string") return;
      this.lines.set(toBareId(r.tileId), r.line);
      this.o.lineChanged?.();
      return;
    }
    if (method === "agent.screen") {
      // A daemon read an agent's screen: its status until the agent's hooks report, and for a wait
      // what screen it is.
      const r = (params ?? {}) as { tileId?: string; state?: ScreenState; says?: unknown };
      if (!r.tileId || !r.state || !SCREEN_STATES.has(r.state)) return;
      this.status.screen(toBareId(r.tileId), r.state, typeof r.says === "string" ? r.says : undefined);
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
    const bare = toBareId(evt.tileId);
    // The session an agent reports from is the one its tile resumes; written when it is another.
    if (evt.sessionId && this.recorded.get(evt.tileId) !== evt.sessionId) {
      try {
        writeTrackedSession(path.join(this.o.dir(), TILE_SESSIONS_DIR), evt.tileId, evt.sessionId);
        this.recorded.set(evt.tileId, evt.sessionId);
      } catch { /* best-effort: tried again with its next event */ }
    }
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
    if (evt.event === "session.started") { this.mailbox.started(pid); return; }
    if (evt.event !== "turn.ended") return;
    // A reply a waiting `hive ctl read` took, or one the worker reported itself, goes to no inbox.
    const given = this.turns.recordTurn(pid);
    this.mailbox.setIdle(pid);
    const dests = this.pipes.dests(bare);
    if (dests.length === 0 || given) return;
    const reply = (this.turns.lastReply(pid) ?? "").trim();
    if (!reply) return;
    const sent = { from: bare, name: this.dispatcher.labelOf(bare), kind: "reply" as const, turn: this.turns.currentSeq(pid), text: reply };
    for (const dst of dests) this.inbox.post(dst, sent);
  }

  /**
   * Serve the agent channel behind this machine's daemon, the app's and `hive host`'s alike: the
   * daemon owns the control-plane socket and passes each connection on to this one's own, so every
   * hook its sessions run reaches it and every device watching them (R6). A daemon that will not
   * hand the socket over has this serve the machine's socket itself.
   */
  async serveBehind(daemon: { control(sock: string): Promise<void> }, o: { onWarn(message: string): void; onError?(err: Error): void }): Promise<HcpServer> {
    const own = socketIn(this.o.dir(), "hcp-host.sock", "hcp-host");
    const served = this.listen(own, o.onError);
    for (;;) {
      try {
        await daemon.control(own);
        return served;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (e instanceof ControlRefused) {
          o.onWarn(`the terminal daemon keeps no control-plane socket to hand over (${why}): serving the machine's here`);
          served.close();
          return this.listen(hcpSockPath(this.o.dir()), o.onError);
        }
        o.onWarn(`the terminal daemon did not take this control plane (${why}): asking again`);
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  /**
   * Serve the agent channel on the control-plane socket `sock`: the person holds this machine's token,
   * each agent its tile's (hooks/token.ts). `onError` hears a socket that could not be opened.
   */
  listen(sock: string, onError?: (err: Error) => void): HcpServer {
    const token = readOrCreateToken(this.o.dir());
    return startHcpServer(sock, {
      authenticate: (t) => {
        const holder = holderOf(token, t);
        return !holder ? null : "tile" in holder ? { kind: "tile", tile: toBareId(holder.tile) } : { kind: "person" };
      },
      ...(onError ? { onListenError: onError } : {}),
      rendererUp: () => this.o.windowsUp(),
      dispatch: (method, params, call) => this.agentChannel(method, params, call),
      onEvent: (method, params, from) => {
        // A tile speaks for itself: what it says of another is dropped.
        if (from && !speaksFor(from, (params as { tileId?: unknown } | null)?.tileId)) return;
        this.event(method, params);
      },
    });
  }

  // Each tree its own: one program in a loop does not stop the person or others starting agents.
  private spawnAllowed(by: string): boolean {
    const now = Date.now();
    for (const [who, times] of this.spawnTimes) {
      const recent = times.filter((t) => now - t < 60_000);
      if (recent.length) this.spawnTimes.set(who, recent);
      else this.spawnTimes.delete(who);
    }
    const times = this.spawnTimes.get(by) ?? [];
    let all = 0;
    for (const t of this.spawnTimes.values()) all += t.length;
    if (times.length >= SPAWNS_A_MINUTE || all >= SPAWNS_ALL_A_MINUTE) return false;
    this.spawnTimes.set(by, [...times, now]);
    return true;
  }
}
