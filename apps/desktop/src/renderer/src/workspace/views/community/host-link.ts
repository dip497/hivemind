/**
 * host-link — the host end of one community view's MessagePort. Pure logic:
 * validates every inbound message (protocol.ts), enforces the permission the
 * manifest was granted, counts what it refuses, and disables the plugin past a
 * threshold. No DOM, no React — CommunityView.tsx owns those; this file is what
 * the unit tests drive with a fake port.
 *
 * Disable rules (any one trips it, `onDisable(reason)` fires once):
 *   • ≥ LIMITS.malformed refused messages (malformed, unknown, before `ready`,
 *     a command without its permission, a command naming a tile that does not
 *     exist);
 *   • > LIMITS.messagesPerSecond inbound messages in one second (a flood);
 *   • > LIMITS.longTaskMsPerWindow ms of main-thread long tasks attributed to
 *     the plugin's iframe within LIMITS.windowMs (a runaway render loop). The
 *     component feeds these in from a PerformanceObserver.
 */
import {
  ACTIVITY_MIN_INTERVAL_MS, COMMAND_PERMISSION, EVENT_REPLAY_MAX, PROTOCOL_VERSION, customNameMatches, parsePluginMessage,
  type ActivityLevel, type HostMessage, type PluginMessage, type RequestErrorCode, type ShareOutcome, type SurfaceRect, type ViewEvent,
  type ViewEventKind, type ViewFeature, type ViewHistoryDay, type ViewPermission, type ViewPresence, type ViewRect,
  type ViewAgent, type ViewAgentStatus, type ViewSession, type ViewStatus,
} from "@hivemind/view-sdk/protocol";
import type { WorkspaceCommands } from "../../workspace-view";
import { AGENT_TILE_KIND, type TileKind } from "../../../tile-kinds";
import { bucketTileStatus } from "../../tile-status-bucket";

/** Kinds a plugin may spawn (no planReview: that is opened by the control plane). */
const SPAWNABLE: readonly string[] = [AGENT_TILE_KIND, "shell", "editor", "diff", "issues", "browser", "workbench"];

export const LIMITS = {
  malformed: 8,
  messagesPerSecond: 600,
  longTaskMsPerWindow: 1500,
  windowMs: 3000,
};

/** The 1.3 sources a host wired. A feature is advertised in `hello` only when its source is here. */
export interface LinkServices {
  sinceOf?: (tileId: string) => { since: number; exact: boolean } | undefined;
  /** A listener returns whether the event matched its subscription. */
  events?: { subscribe(l: (e: ViewEvent, target?: string) => boolean): () => void; replay(since: number, accept: (e: ViewEvent) => boolean, viewId: string): ViewEvent[] };
  activity?: { level(tileId: string): ActivityLevel; subscribe(cb: (changed: Record<string, ActivityLevel>) => void): () => void; watch(owner: object, tileIds: string[]): void };
  /** Replays the current state to a new subscriber. */
  presence?: { subscribe(cb: (p: ViewPresence) => void): () => void };
  history?: (day: string) => Promise<ViewHistoryDay>;
  share?: (png: ArrayBuffer, suggestedName?: string) => Promise<ShareOutcome>;
  /** 1.4: an agent tile's full status; the current one now, then each change. */
  agentStatus?: (tileId: string, cb: (s: ViewAgentStatus) => void) => () => void;
  agents?: () => ViewAgent[];
  /** A frame's folder's past sessions. Rejects with `{ code: "UNSUPPORTED" }` for a frame it cannot list. */
  sessions?: (agent: string, frameId: string) => Promise<ViewSession[]>;
  /** The host's confirm for a prompt the view wrote: true when the user sends it. */
  confirmPrompt?: (req: { agent: string | null; tileId?: string; frameId: string | null; text: string }) => Promise<boolean>;
  /** Type a confirmed prompt into an agent tile. Rejects with `{ code: "BAD_REQUEST" }` for a tile that is not one. */
  sendPrompt?: (tileId: string, text: string) => Promise<void>;
}

export const SHARE_DECLINES_MAX = 3;
export const PROMPT_DECLINES_MAX = 3;

export function linkFeatures(s: LinkServices): ViewFeature[] {
  const f: ViewFeature[] = [];
  if (s.sinceOf) f.push("since");
  if (s.events) f.push("events");
  if (s.activity) f.push("activity");
  if (s.presence) f.push("presence");
  if (s.history) f.push("history");
  if (s.share) f.push("share");
  if (s.agentStatus) f.push("agentStatus");
  if (s.agents) f.push("agents");
  if (s.sessions) f.push("sessions");
  if (s.confirmPrompt && s.sendPrompt) f.push("prompt");
  return f;
}

export interface LinkDeps {
  pluginId: string;
  capabilities: ViewPermission[];
  commands: WorkspaceCommands;
  /** Ids the plugin may name in commands (the current tiles). */
  hasTile: (id: string) => boolean;
  hasFrame: (id: string) => boolean;
  onReady: () => void;
  onSurfaceRects: (rects: SurfaceRect[]) => void;
  onLayout: (data: unknown) => void;
  onFramesDrawn: (count: number) => void;
  onError: (message: string) => void;
  onDisable: (reason: string) => void;
  now?: () => number;
  services?: LinkServices;
  schedule?: (fn: () => void, ms: number) => unknown;
}

export interface LinkStats {
  received: number;
  refused: number;
  ready: boolean;
  disabled: string | null;
  framesDrawn: number;
  statusSubscriptions: number;
}

interface PortLike { postMessage(msg: unknown): void; onmessage: ((e: MessageEvent) => void) | null; start?: () => void; close?: () => void }

export class CommunityLink {
  readonly stats: LinkStats = { received: 0, refused: 0, ready: false, disabled: null, framesDrawn: 0, statusSubscriptions: 0 };
  private port: PortLike | null = null;
  private statusUnsubs = new Map<string, () => void>();
  private windowStart = 0;
  private windowCount = 0;
  private longTasks: Array<{ t: number; ms: number }> = [];
  private reveals = new Map<number, (rect: ViewRect | null) => void>();
  private nextRequest = 1;
  private readonly now: () => number;
  private readonly services: LinkServices;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  readonly features: ViewFeature[];
  private visible = true;
  private eventSub: { kinds: Set<ViewEventKind>; custom: string[] } | null = null;
  private eventUnsub: (() => void) | null = null;
  private eventQueue: ViewEvent[] = [];
  private watched = new Set<string>();
  private activityUnsub: (() => void) | null = null;
  private activityPending: Record<string, ActivityLevel> = {};
  private activityTimer = false;
  private lastActivitySent = -Infinity;
  private presenceUnsub: (() => void) | null = null;
  private historyBusy = false;
  private sharePending = false;
  private shareDeclines = 0;
  private promptPending = false;
  private promptDeclines = 0;

  constructor(private deps: LinkDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.services = deps.services ?? {};
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.features = linkFeatures(this.services);
  }

  /** The view's document was hidden or shown: activity pauses while hidden and catches up after. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible || this.watched.size === 0 || !this.services.activity) return;
    for (const id of this.watched) this.activityPending[id] = this.services.activity.level(id);
    this.queueActivity();
  }

  attach(port: PortLike): void {
    this.port = port;
    port.onmessage = (e) => this.handle(e.data);
    port.start?.();
  }

  send(msg: HostMessage): void {
    if (this.stats.disabled || !this.port) return;
    try { this.port.postMessage(msg); } catch { /* port gone */ }
  }

  /** Ask the plugin where a tile is (its rect in the plugin viewport, or null). */
  reveal(tileId: string, timeoutMs = 2000): Promise<ViewRect | null> {
    if (this.stats.disabled || !this.stats.ready) return Promise.resolve(null);
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.reveals.delete(requestId); resolve(null); }, timeoutMs);
      this.reveals.set(requestId, (rect) => { clearTimeout(timer); resolve(rect); });
      this.send({ type: "reveal", requestId, tileId });
    });
  }

  /** Feed a main-thread long task attributed to the plugin's iframe. */
  noteLongTask(ms: number): void {
    if (this.stats.disabled) return;
    const t = this.now();
    this.longTasks.push({ t, ms });
    const cutoff = t - LIMITS.windowMs;
    while (this.longTasks.length && this.longTasks[0]!.t < cutoff) this.longTasks.shift();
    const total = this.longTasks.reduce((a, b) => a + b.ms, 0);
    if (total > LIMITS.longTaskMsPerWindow) this.disable(`runaway: ${Math.round(total)} ms of long tasks in ${LIMITS.windowMs / 1000} s`);
  }

  dispose(): void {
    this.eventUnsub?.(); this.eventUnsub = null;
    this.activityUnsub?.(); this.activityUnsub = null;
    if (this.services.activity && this.watched.size) this.services.activity.watch(this, []);
    this.watched.clear();
    this.presenceUnsub?.(); this.presenceUnsub = null;
    for (const u of this.statusUnsubs.values()) u();
    this.statusUnsubs.clear();
    this.stats.statusSubscriptions = 0;
    if (this.port) { this.port.onmessage = null; this.port.close?.(); this.port = null; }
  }

  private disable(reason: string) {
    if (this.stats.disabled) return;
    this.stats.disabled = reason;
    this.dispose();
    this.deps.onDisable(reason);
  }

  private refuse(why: string) {
    this.stats.refused++;
    console.warn(`[hivemind] view "${this.deps.pluginId}" refused: ${why}`);
    if (this.stats.refused >= LIMITS.malformed) this.disable(`${this.stats.refused} malformed or unauthorised messages (last: ${why})`);
  }

  /** Public for tests; the port handler routes here. */
  handle(raw: unknown): void {
    if (this.stats.disabled) return;
    this.stats.received++;
    const t = this.now();
    if (t - this.windowStart >= 1000) { this.windowStart = t; this.windowCount = 0; }
    if (++this.windowCount > LIMITS.messagesPerSecond) { this.disable(`message flood: >${LIMITS.messagesPerSecond} messages in one second`); return; }
    const r = parsePluginMessage(raw);
    if (!r.ok) { this.refuse(r.reason); return; }
    const m: PluginMessage = r.msg;
    if (!this.stats.ready) {
      if (m.type !== "ready") { this.refuse(`${m.type} before ready`); return; }
      if (m.v !== PROTOCOL_VERSION) { this.disable(`protocol version ${m.v} is not supported (host speaks ${PROTOCOL_VERSION})`); return; }
      this.stats.ready = true;
      this.deps.onReady();
      return;
    }
    switch (m.type) {
      case "ready": this.refuse("duplicate ready"); return;
      case "command": this.command(m.name, m.args); return;
      case "subscribeStatus": {
        if (!this.deps.hasTile(m.tileId)) { this.refuse(`subscribeStatus: unknown tile ${m.tileId}`); return; }
        if (this.statusUnsubs.has(m.tileId)) return;
        const tileId = m.tileId;
        let bucket: ViewStatus | null = null;
        let agent: ViewAgentStatus | undefined;
        const push = () => {
          if (bucket === null) return;
          const s = this.services.sinceOf?.(tileId);
          this.send({ type: "status", tileId, status: bucket, ...(s ? { since: s.since, exact: s.exact } : {}), ...(agent ? { agent } : {}) });
        };
        const offBus = this.deps.commands.subscribeTileStatus(tileId, (status) => { bucket = bucketTileStatus(status); push(); });
        const offAgent = this.services.agentStatus?.(tileId, (a) => {
          if (agent && JSON.stringify(agent) === JSON.stringify(a)) return;
          agent = a;
          push();
        });
        this.statusUnsubs.set(tileId, () => { offBus(); offAgent?.(); });
        this.stats.statusSubscriptions = this.statusUnsubs.size;
        return;
      }
      case "unsubscribeStatus": {
        this.statusUnsubs.get(m.tileId)?.();
        this.statusUnsubs.delete(m.tileId);
        this.stats.statusSubscriptions = this.statusUnsubs.size;
        return;
      }
      case "surfaceRects": {
        const rects = m.rects.filter((r) => this.deps.hasTile(r.tileId));
        if (rects.length !== m.rects.length) this.refuse("surfaceRects: unknown tile");
        this.deps.onSurfaceRects(rects);
        return;
      }
      case "revealed": {
        const cb = this.reveals.get(m.requestId);
        if (!cb) { this.refuse(`revealed: unknown requestId ${m.requestId}`); return; }
        this.reveals.delete(m.requestId);
        cb(m.rect);
        return;
      }
      case "framesDrawn": this.stats.framesDrawn = m.count; this.deps.onFramesDrawn(m.count); return;
      case "layout": this.deps.onLayout(m.data); return;
      case "error": this.deps.onError(m.message); return;
      case "subscribeEvents": this.subscribeEvents(m.kinds, m.custom ?? [], m.replaySince); return;
      case "unsubscribeEvents": this.eventUnsub?.(); this.eventUnsub = null; this.eventSub = null; return;
      case "watchActivity": this.watchActivity(m.tileIds); return;
      case "subscribePresence": {
        if (!this.services.presence) { this.refuse("subscribePresence: not supported"); return; }
        if (!this.presenceUnsub) this.presenceUnsub = this.services.presence.subscribe((presence) => this.send({ type: "presence", presence }));
        return;
      }
      case "unsubscribePresence": this.presenceUnsub?.(); this.presenceUnsub = null; return;
      case "request": this.request(m); return;
    }
  }

  private subscribeEvents(kinds: ViewEventKind[], custom: string[], replaySince: number | undefined) {
    const events = this.services.events;
    if (!events) { this.refuse("subscribeEvents: not supported"); return; }
    const sub = { kinds: new Set(kinds), custom };
    this.eventSub = sub;
    const wants = (e: ViewEvent) => sub.kinds.has(e.kind) && (e.kind !== "custom" || customNameMatches(sub.custom, e.name));
    if (!this.eventUnsub) {
      this.eventUnsub = events.subscribe((e, target) => {
        const s = this.eventSub;
        if (target && target !== this.deps.pluginId) return false;
        if (!s || !s.kinds.has(e.kind) || (e.kind === "custom" && !customNameMatches(s.custom, e.name))) return false;
        if (this.eventQueue.push(e) === 1) queueMicrotask(() => this.flushEvents());
        return true;
      });
    }
    if (replaySince !== undefined) {
      const replay = events.replay(replaySince, wants, this.deps.pluginId).slice(-EVENT_REPLAY_MAX);
      if (replay.length) this.send({ type: "events", events: replay, replay: true });
    }
  }

  // Everything emitted in one task goes out as one message.
  private flushEvents() {
    const events = this.eventQueue;
    this.eventQueue = [];
    if (events.length) this.send({ type: "events", events });
  }

  private watchActivity(tileIds: string[]) {
    const activity = this.services.activity;
    if (!activity) { this.refuse("watchActivity: not supported"); return; }
    const known = tileIds.filter((id) => this.deps.hasTile(id));
    if (known.length !== tileIds.length) this.refuse("watchActivity: unknown tile");
    const next = new Set(known);
    for (const id of next) if (!this.watched.has(id)) this.activityPending[id] = activity.level(id);
    for (const id of Object.keys(this.activityPending)) if (!next.has(id)) delete this.activityPending[id];
    this.watched = next;
    activity.watch(this, known);
    if (next.size && !this.activityUnsub) {
      this.activityUnsub = activity.subscribe((changed) => {
        let any = false;
        for (const [id, l] of Object.entries(changed)) if (this.watched.has(id)) { this.activityPending[id] = l; any = true; }
        if (any) this.queueActivity();
      });
    } else if (!next.size) { this.activityUnsub?.(); this.activityUnsub = null; }
    this.queueActivity();
  }

  // At most one activity message per ACTIVITY_MIN_INTERVAL_MS, none while hidden.
  private queueActivity() {
    if (this.activityTimer || !this.visible || Object.keys(this.activityPending).length === 0) return;
    const wait = Math.max(0, this.lastActivitySent + ACTIVITY_MIN_INTERVAL_MS - this.now());
    this.activityTimer = true;
    this.schedule(() => {
      this.activityTimer = false;
      if (!this.visible) return;
      const levels = this.activityPending;
      this.activityPending = {};
      if (Object.keys(levels).length === 0) return;
      this.lastActivitySent = this.now();
      this.send({ type: "activity", levels });
    }, wait);
  }

  private request(m: Extract<PluginMessage, { type: "request" }>) {
    const reply = (p: Promise<unknown>) => p.then(
      (result) => this.send({ type: "response", requestId: m.requestId, ok: true, result }),
      (e: unknown) => {
        const code = (e as { code?: unknown })?.code;
        this.fail(m.requestId, code === "UNSUPPORTED" || code === "BAD_REQUEST" ? code : "INTERNAL", (e as Error)?.message ?? String(e));
      },
    );
    const granted = (p: ViewPermission) => (this.deps.capabilities.includes(p) ? true : (this.fail(m.requestId, "DECLINED", `${m.name} needs permission "${p}"`), false));
    if (m.name === "agents") {
      const agents = this.services.agents;
      if (!agents) { this.fail(m.requestId, "UNSUPPORTED", "agents are not listed here"); return; }
      void reply(Promise.resolve().then(() => ({ agents: agents() })));
      return;
    }
    if (m.name === "sessions") {
      const sessions = this.services.sessions;
      if (!sessions) { this.fail(m.requestId, "UNSUPPORTED", "sessions are not listed here"); return; }
      if (!granted("workspace:sessions")) return;
      if (!this.deps.hasFrame(m.args[0].frameId)) { this.fail(m.requestId, "BAD_REQUEST", `unknown frame ${m.args[0].frameId}`); return; }
      void reply(sessions(m.args[0].agent, m.args[0].frameId).then((list) => ({ sessions: list })));
      return;
    }
    if (m.name === "prompt") {
      const { confirmPrompt, sendPrompt } = this.services;
      if (!confirmPrompt || !sendPrompt) { this.fail(m.requestId, "UNSUPPORTED", "prompts are not available"); return; }
      if (!granted("workspace:prompt")) return;
      const { tileId, text } = m.args[0];
      if (!this.deps.hasTile(tileId)) { this.fail(m.requestId, "BAD_REQUEST", `unknown tile ${tileId}`); return; }
      const why = this.promptBlocked();
      if (why) { this.fail(m.requestId, why.code, why.message); return; }
      this.promptPending = true;
      void reply(confirmPrompt({ agent: null, tileId, frameId: null, text }).then(async (ok) => {
        if (!ok) { this.promptDeclines++; return { outcome: "cancelled" }; }
        await sendPrompt(tileId, text);
        return { outcome: "sent" };
      }).finally(() => { this.promptPending = false; }));
      return;
    }
    if (m.name === "history") {
      const history = this.services.history;
      if (!history) { this.fail(m.requestId, "UNSUPPORTED", "history is not available"); return; }
      if (this.historyBusy) { this.fail(m.requestId, "BUSY", "a history request is already running"); return; }
      this.historyBusy = true;
      void reply(history(m.args[0].day).finally(() => { this.historyBusy = false; }));
      return;
    }
    const share = this.services.share;
    if (!share) { this.fail(m.requestId, "UNSUPPORTED", "sharing is not available"); return; }
    if (this.shareDeclines >= SHARE_DECLINES_MAX) { this.fail(m.requestId, "DECLINED", "the user declined to share"); return; }
    if (this.sharePending || !this.visible) { this.fail(m.requestId, "BUSY", this.sharePending ? "a share is already waiting" : "the view is hidden"); return; }
    this.sharePending = true;
    void reply(share(m.args[0].png, m.args[0].suggestedName).then((outcome) => {
      if (outcome === "cancelled") this.shareDeclines++;
      return { outcome };
    }).finally(() => { this.sharePending = false; }));
  }

  /** Why a prompt cannot be shown now: one at a time, not while hidden, not after the user said no three times. */
  private promptBlocked(): { code: RequestErrorCode; message: string } | null {
    if (this.promptDeclines >= PROMPT_DECLINES_MAX) return { code: "DECLINED", message: "the user declined this view's prompts" };
    if (this.promptPending || !this.visible) return { code: "BUSY", message: this.promptPending ? "a prompt is already waiting" : "the view is hidden" };
    return null;
  }

  private fail(requestId: number, code: RequestErrorCode, message: string) {
    this.send({ type: "response", requestId, ok: false, error: { code, message } });
  }

  /** A tile closed: drop its subscription silently (the plugin will hear it in `structure`). */
  dropTile(tileId: string): void {
    if (this.watched.delete(tileId)) { delete this.activityPending[tileId]; this.services.activity?.watch(this, [...this.watched]); }
    this.statusUnsubs.get(tileId)?.();
    if (this.statusUnsubs.delete(tileId)) this.stats.statusSubscriptions = this.statusUnsubs.size;
  }

  private command(name: keyof typeof COMMAND_PERMISSION, args: unknown[]) {
    const need = COMMAND_PERMISSION[name];
    if (need && !this.deps.capabilities.includes(need)) { this.refuse(`${name} needs permission "${need}"`); return; }
    const c = this.deps.commands;
    const tile = (id: unknown) => (id === null || this.deps.hasTile(id as string) ? true : (this.refuse(`${name}: unknown tile ${String(id)}`), false));
    const frame = (id: unknown) => (id === null || this.deps.hasFrame(id as string) ? true : (this.refuse(`${name}: unknown frame ${String(id)}`), false));
    switch (name) {
      case "selectTile": if (tile(args[0])) c.selectTile(args[0] as string | null); return;
      case "selectFrame": if (frame(args[0])) c.selectFrame(args[0] as string | null); return;
      case "focusTile": if (tile(args[0])) c.focusTile(args[0] as string, args[1] as { exact?: boolean } | undefined); return;
      case "closeTile": if (tile(args[0])) c.closeTile(args[0] as string); return;
      case "spawnTile":
        if (!SPAWNABLE.includes(args[0] as string)) { this.refuse(`spawnTile: unknown kind ${String(args[0])}`); return; }
        if (frame(args[1])) c.spawnTile(args[0] as TileKind, args[1] as string | null);
        return;
      case "spawnVis": c.spawnVis(args[0] as "tree" | "shell" | "diff" | "issues"); return;
      case "spawnClaude": c.spawnClaude(); return;
      case "addFrame": c.addFrame(); return;
      case "spawnAgent": {
        const opts = args[2] as { prompt?: string; name?: string; resume?: string } | undefined;
        if (opts?.prompt !== undefined && !this.deps.capabilities.includes("workspace:prompt")) { this.refuse('spawnAgent with a prompt needs permission "workspace:prompt"'); return; }
        if (opts?.resume !== undefined && !this.deps.capabilities.includes("workspace:sessions")) { this.refuse('spawnAgent with resume needs permission "workspace:sessions"'); return; }
        if (!frame(args[1])) return;
        const go = () => {
          if (!c.spawnAgent(args[0] as string | null, args[1] as string | null, opts)) this.refuse(`spawnAgent: no agent ${String(args[0] ?? "installed")}`);
        };
        if (opts?.prompt === undefined) { go(); return; }
        // The prompt is what the agent will do: the user reads it first.
        const confirm = this.services.confirmPrompt;
        if (!confirm) { this.refuse("spawnAgent: prompts are not available"); return; }
        const why = this.promptBlocked();
        if (why) { this.refuse(`spawnAgent: ${why.message}`); return; }
        this.promptPending = true;
        void confirm({ agent: args[0] as string | null, frameId: args[1] as string | null, text: opts.prompt })
          .then((ok) => { if (ok) go(); else this.promptDeclines++; }, () => { /* no dialog: nothing runs */ })
          .finally(() => { this.promptPending = false; });
        return;
      }
      case "renameTile": if (tile(args[0])) c.renameTile(args[0] as string, args[1] as string); return;
      case "openFolder": if (frame(args[0])) c.openFolder(args[0] as string); return;
    }
  }
}
