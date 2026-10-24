/**
 * The plugin-side client. A community view calls `connect()` once, then talks
 * to hivemind through typed methods and events — never `postMessage` directly.
 *
 *   const hm = await connect();
 *   hm.on("structure", ({ frames, tiles }) => rebuild(frames, tiles));
 *   const off = hm.subscribeStatus(tileId, (s) => paint(tileId, s));
 *   hm.commands.selectTile(tileId);
 *   hm.setSurfaceRects([{ tileId, x, y, w, h }]);   // a live terminal appears here
 *   hm.onParticipants((people) => ring(people));      // 1.5: who else is here, and on what
 *
 * The host hands the MessagePort over with a `PORT_HANDSHAKE` window message
 * right after the iframe loads; `connect()` resolves once `hello` arrives.
 */
import type { SettingValue } from "./settings.js";
import { chordMatches } from "./commands.js";
import { isTokenId, tokenVar } from "./tokens.js";
import {
  CLIENT_VALUES_UNTIL_KNOWN, COMMAND_PERMISSION, areFontFaces, PORT_HANDSHAKE, PROTOCOL_VERSION, STATUS_TONES, customNameMatches, parseHostMessage, promptProblem,
  type ActivityLevel, type ViewFontFace, type PromptOutcome, type ViewAgent, type ViewAgentStatus, type ViewSession, type CommandName, type HostMessage, type PluginMessage, type RequestErrorCode, type ShareOutcome, type StatusTone, type SurfaceRect, type LineRect, type CommandKeys,
  type ViewCommands, type ViewDevice, type ViewEvent, type ViewEventKind, type ViewFeature, type ViewHistoryDay, type ViewParticipant, type ViewPermission, type ViewPresence, type ViewRect, type ViewStatus, type ViewTheme, type ViewWidget,
  ISSUE_CALLS, type IssueCall, type ViewIssue, type ViewIssueAssignee, type ViewIssueState, type ViewIssueSummary,
} from "./protocol.js";

/** A request the host refused or could not answer (`UNSUPPORTED` when it lacks the feature). */
/** How long an invoked command waits for its handler to be registered. */
const HANDLER_WAIT_MS = 1000;

export class HostError extends Error {
  constructor(readonly code: RequestErrorCode, message: string) { super(message); this.name = "HostError"; }
}

/** 1.3: what arrives with a status — absent from a host that predates it. 1.4: `agent`, on agent tiles. */
export interface StatusInfo { since?: number; exact?: boolean; agent?: ViewAgentStatus }

type Hello = Extract<HostMessage, { type: "hello" }>;
type EventMap = {
  structure: Extract<HostMessage, { type: "structure" }>;
  names: Extract<HostMessage, { type: "names" }>;
  selection: Extract<HostMessage, { type: "selection" }>;
  resize: { w: number; h: number };
  visibility: { visible: boolean };
  theme: Extract<HostMessage, { type: "theme" }>["theme"];
  /** 1.7: every declared setting's value, after the person changed one. */
  settings: Record<string, SettingValue>;
  /** The host undocked this surface (its bar, or Shift+Esc); the tile is
   *  already released — forget the rect. The client drops it from what it
   *  last sent, so a plugin that ignores the event still stays consistent. */
  undock: { tileId: string };
};

export interface ViewClient {
  readonly hello: Hello;
  readonly capabilities: readonly ViewPermission[];
  /** Latest viewport size / visibility as told by the host. */
  readonly viewport: { w: number; h: number };
  readonly visible: boolean;
  /** 1.5: what the view is shown on. A host that predates it is a desktop's: no touch, not compact. */
  readonly device: ViewDevice;
  /** 1.7: what the person set this view to, one value per field its manifest's `settings` declares.
   *  Empty from a host that predates it. Changes arrive as the `settings` event. */
  readonly settings: Readonly<Record<string, SettingValue>>;
  /** What the host says. One that says how things are now (structure, names, selection, resize,
   *  visibility, theme, settings) replays its latest to a new listener, at once. */
  on<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): () => void;
  /** Per-tile status. Subscribes on first listener, unsubscribes on last. */
  subscribeStatus(tileId: string, cb: (status: ViewStatus, info?: StatusInfo) => void): () => void;
  /** 1.3: the features this host wired (`hello.features`). */
  readonly features: readonly ViewFeature[];
  supports(feature: ViewFeature): boolean;
  /** 1.3: discrete events of these kinds. `replaySince` asks for buffered ones at or after that time. */
  onEvents(kinds: readonly ViewEventKind[], cb: (event: ViewEvent) => void, opts?: { replaySince?: number }): () => void;
  /** 1.3: custom events (`hive ctl view emit`) whose name matches; "ci.*" matches everything under ci. */
  onCustom(patterns: string | readonly string[], cb: (event: Extract<ViewEvent, { kind: "custom" }>) => void, opts?: { replaySince?: number }): () => void;
  /** 1.3: a tile's output level, at most 4 per second, nothing while hidden. */
  activity(tileId: string, cb: (level: ActivityLevel) => void): () => void;
  /** 1.3: whether the user is at the machine. The latest state replays to a new listener. */
  onPresence(cb: (presence: ViewPresence) => void): () => void;
  /** 1.5: everyone else in the workspace — who, their colour, the tile their pointer is over and
   *  what they selected, of this view's. On every change; the latest replays to a new listener. */
  onParticipants(cb: (participants: ViewParticipant[]) => void): () => void;
  /** 1.8: every widget in the workspace, now and whenever one changes. A host before 1.8 sends none. */
  onWidgets(cb: (widgets: ViewWidget[]) => void): () => void;
  /** 1.8, `workspace:widgets`: press one of a widget's buttons, as a person pressing it where it is drawn. */
  pressWidget(id: string, action: unknown): void;
  /** 1.8: click a widget's card, not on a button. */
  clickWidget(id: string): void;
  /** 1.9: the workspace's issues, now and whenever one changes; needs `workspace:issues`. A host
   *  before 1.9 sends none. */
  onIssues(cb: (issues: ViewIssueSummary[]) => void): () => void;
  /** 1.10: answer the command `name` your manifest declares, when an agent runs it
   *  (`hive ctl plugin call`): the handler gets its JSON argument, and what it returns (or a promise
   *  of it) is the agent's answer; what it throws, the agent's error. One handler per name. */
  onCommand(name: string, handler: (args: unknown) => unknown): () => void;
  /** 1.9: the workspace's issue methods. Like `onIssues`, they need `workspace:issues`. */
  readonly issues: ViewIssues;
  /** 1.3: per-tile status intervals for a local day (YYYY-MM-DD). */
  history(day: string): Promise<ViewHistoryDay>;
  /** 1.3: ask the user to copy or save this PNG; resolves with what they chose. */
  share(png: ArrayBuffer, opts?: { suggestedName?: string }): Promise<ShareOutcome>;
  /** 1.4: the agents this machine can start and what each supports. */
  agents(): Promise<ViewAgent[]>;
  /** 1.4, `workspace:sessions`: an agent's past sessions in a frame's folder, newest first.
   *  Continue one with `commands.spawnAgent(agent, frameId, { resume: id })`. */
  sessions(agent: string, frameId: string): Promise<ViewSession[]>;
  /** 1.4, `workspace:prompt`: give an agent tile an instruction. The user sees it first and
   *  sends or cancels it; resolves with what they chose. */
  prompt(tileId: string, text: string): Promise<PromptOutcome>;
  /** Typed commands; one the manifest did not request throws locally. */
  readonly commands: ViewCommands;
  /** The hole-punch — deduplicated: identical rects are not re-sent. A rect goes to the host once
   *  a `structure` has named its tile, and leaves when one no longer does. */
  setSurfaceRects(rects: SurfaceRect[]): void;
  /** 1.17 (feature `lineSlots`): where the host draws each tile's last line, or what its agent
   *  waits on with Allow and Deny (`LineRect`, at least 20px high), in place of those set before.
   *  The view reserves the room; the text never reaches it. Deduplicated, held back for a tile no
   *  `structure` named yet, as surfaces are; nothing is sent to a host without the feature. */
  setLineRects(rects: LineRect[]): void;
  /** The host asked to reveal a tile; answer with where it is (or null). */
  onReveal(handler: (tileId: string) => ViewRect | null | Promise<ViewRect | null>): () => void;
  /** Count a drawn frame (reported to the host, throttled). */
  reportFrame(): void;
  readonly framesDrawn: number;
  /** Persist an opaque blob under the plugin id (debounced). */
  /** Keep `data` as this view's layout. Saves are gathered for a moment, as a drag makes many; `now`
   *  sends this one at once, for a change made in one step (a click), so a view switched away from
   *  straight after it still has it. */
  setLayout(data: unknown, opts?: { now?: boolean }): void;
  /** Report a non-fatal problem to the host log. */
  error(message: string): void;
}

/** What a client gives that runs elsewhere than where it is used (a widget's worker): the calls,
 *  by name, and the values it holds, which the other side keeps a copy of. Surfaces and reveals
 *  are a view's own and are not among them. */
export const CLIENT_CALLS = [
  "on", "subscribeStatus", "supports", "onEvents", "onCustom", "activity", "onPresence", "onParticipants", "onWidgets", "onIssues", "onCommand",
  "pressWidget", "clickWidget", "history", "share", "agents", "sessions", "prompt", "setLayout", "error",
] as const satisfies readonly (keyof ViewClient)[];
export const CLIENT_VALUES = Object.keys(CLIENT_VALUES_UNTIL_KNOWN) as (keyof typeof CLIENT_VALUES_UNTIL_KNOWN)[] satisfies readonly (keyof ViewClient)[];

/** The workspace's issue methods (1.9), each answered with what the workspace's own returns. */
export interface ViewIssues {
  read(id: string): Promise<ViewIssue>;
  create(issue: { title: string; state?: ViewIssueState; parent?: string; labels?: string[]; assignee?: ViewIssueAssignee | null; description?: string; acceptanceCriteria?: { done: boolean; text: string }[] }): Promise<ViewIssue>;
  /** Change its fields: title, labels, assignee, parent, description, acceptance criteria. */
  update(id: string, patch: Record<string, unknown>): Promise<ViewIssue>;
  /** A new state, with a note in the same activity entry. */
  setState(id: string, state: ViewIssueState, note?: string): Promise<ViewIssue>;
  comment(id: string, message: string): Promise<ViewIssue>;
  delete(id: string): Promise<void>;
  /** Relate it to `other`, which may be in another of the host's workspaces. */
  link(id: string, other: string, type: string): Promise<unknown>;
  unlink(id: string, other: string): Promise<{ removed: number }>;
  /** Into the host's workspace with prefix `prefix`; the result names the issue there (`newId`). */
  move(id: string, prefix: string, mode: "move" | "copy"): Promise<{ newId: string; mode: "move" | "copy"; from: string }>;
  /** The host's other workspaces an issue can go to: their prefix and title. */
  workspaces(): Promise<{ prefix: string; title: string }[]>;
  /** 1.12: whether this workspace keeps issues yet, and the prefix `setUp` would suggest. */
  status(): Promise<ViewIssuesStatus>;
  /** 1.12: start keeping issues in this workspace's folder, their ids starting `prefix`. */
  setUp(prefix: string): Promise<ViewIssuesStatus>;
}

/** Whether a workspace keeps issues: `ready` once set up; `folder` names where they would live. */
export interface ViewIssuesStatus { ready: boolean; folder: string | null; suggested: string }

export interface ConnectOptions {
  /** Where to listen for the handshake (default `window`). */
  target?: Window;
  /** Give up after this long without a hello (default 10 s). */
  timeoutMs?: number;
}

export function connect(opts: ConnectOptions = {}): Promise<ViewClient> {
  const target = opts.target ?? window;
  return new Promise<ViewClient>((resolve, reject) => {
    const timer = setTimeout(() => { target.removeEventListener("message", onWindow); reject(new Error("hivemind: no host handshake")); }, opts.timeoutMs ?? 10_000);
    const onWindow = (e: MessageEvent) => {
      const port = e.ports?.[0];
      if (!port || !e.data || (e.data as { type?: unknown }).type !== PORT_HANDSHAKE) return;
      target.removeEventListener("message", onWindow);
      clearTimeout(timer);
      new Client(port).whenReady().then(resolve, reject);
    };
    target.addEventListener("message", onWindow);
  });
}

/** Events that say how things are now (not that something happened): replayed to a late listener. */
const STATE_EVENTS = new Set<string>(["structure", "names", "selection", "resize", "visibility", "theme", "settings"]);

interface EventListener { kinds: Set<ViewEventKind>; custom: string[]; cb: (e: ViewEvent) => void; lastSeq: number }

class Client implements ViewClient {
  hello!: Hello;
  capabilities: readonly ViewPermission[] = [];
  viewport = { w: 0, h: 0 };
  visible = true;
  settings: Readonly<Record<string, SettingValue>> = {};
  framesDrawn = 0;
  readonly commands: ViewCommands;
  private listeners = new Map<string, Set<(p: unknown) => void>>();
  private status = new Map<string, Set<(s: ViewStatus, info?: StatusInfo) => void>>();
  private eventListeners = new Set<EventListener>();
  private lastEventSubscription = "";
  private eventSyncQueued = false;
  private pendingReplaySince: number | undefined;
  private activityCbs = new Map<string, Set<(l: ActivityLevel) => void>>();
  private lastWatched = "";
  private activitySyncQueued = false;
  private presenceCbs = new Set<(p: ViewPresence) => void>();
  private presence: ViewPresence | null = null;
  private participantCbs = new Set<(p: ViewParticipant[]) => void>();
  private participants: ViewParticipant[] | null = null;
  private widgets: ViewWidget[] | null = null;
  private issueList: ViewIssueSummary[] | null = null;
  private issueCbs = new Set<(issues: ViewIssueSummary[]) => void>();
  private commandHandlers = new Map<string, (args: unknown) => unknown>();
  readonly issues: ViewIssues = Object.fromEntries(ISSUE_CALLS.map((call) => [call, (...args: unknown[]) => this.issueCall(call, args)])) as unknown as ViewIssues;
  private widgetCbs = new Set<(widgets: ViewWidget[]) => void>();
  private requests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private nextRequest = 1;
  private revealHandler: ((tileId: string) => ViewRect | null | Promise<ViewRect | null>) | null = null;
  /** The rects the view asked for, and the tiles the host has named (the last `structure`). */
  private wantedRects: SurfaceRect[] = [];
  private wantedLines: LineRect[] = [];
  private lastLines = "[]";
  private tiles = new Set<string>();
  /** What the host was last told: nothing, at first. */
  private lastRects = "[]";
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReportedFrames = 0;
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLayout: { data: unknown } | null = null;
  private ready: Promise<void>;

  constructor(private port: MessagePort) {
    this.commands = Object.fromEntries(
      (Object.keys(COMMAND_PERMISSION) as CommandName[]).map((name) => [name, (...args: unknown[]) => this.command(name, args)]),
    ) as unknown as ViewCommands;
    this.ready = new Promise<void>((res) => {
      port.onmessage = (e) => {
        const r = parseHostMessage(e.data);
        if (!r.ok) return;
        if (r.msg.type === "hello") { this.hello = r.msg; this.capabilities = r.msg.capabilities; this.viewport = { ...r.msg.viewport }; this.visible = r.msg.visible; this.settings = r.msg.settings ?? {}; this.bindKeys(r.msg.keys); this.loadFonts(r.msg.fontFaces); res(); return; }
        this.dispatch(r.msg);
      };
    });
    port.start();
    this.send({ type: "ready", v: PROTOCOL_VERSION });
  }

  /** Resolves once hello has arrived (connect() awaits this before handing the client out). */
  whenReady(): Promise<ViewClient> { return this.ready.then(() => this); }

  private send(msg: PluginMessage, transfer: Transferable[] = []) { this.port.postMessage(msg, transfer); }

  private dispatch(m: HostMessage) {
    switch (m.type) {
      case "structure":
        this.tiles = new Set(m.tiles.map((t) => t.id));
        this.sendRects();
        this.sendLines();
        this.emit(m.type, m);
        break;
      case "names": case "selection": this.emit(m.type, m); break;
      case "status": {
        const info: StatusInfo | undefined = m.since === undefined && m.agent === undefined ? undefined : {
          ...(m.since === undefined ? {} : { since: m.since }), ...(m.exact === undefined ? {} : { exact: m.exact }), ...(m.agent ? { agent: m.agent } : {}),
        };
        for (const cb of this.status.get(m.tileId) ?? []) cb(m.status, info);
        break;
      }
      case "events":
        for (const e of m.events) for (const l of [...this.eventListeners]) {
          if (e.seq <= l.lastSeq || !l.kinds.has(e.kind)) continue;
          if (e.kind === "custom" && !customNameMatches(l.custom, e.name)) continue;
          l.lastSeq = e.seq;
          l.cb(e);
        }
        break;
      case "activity":
        for (const [id, level] of Object.entries(m.levels)) for (const cb of this.activityCbs.get(id) ?? []) cb(level);
        break;
      case "presence":
        this.presence = m.presence;
        for (const cb of this.presenceCbs) cb(m.presence);
        break;
      case "widgets":
        this.widgets = m.widgets;
        for (const cb of this.widgetCbs) cb(m.widgets);
        break;
      case "issues":
        this.issueList = m.issues;
        for (const cb of this.issueCbs) cb(m.issues);
        break;
      case "invoke": void this.answer(m.invokeId, m.name, m.args); break;
      case "participants":
        this.participants = m.participants;
        for (const cb of this.participantCbs) cb(m.participants);
        break;
      case "response": {
        const r = this.requests.get(m.requestId);
        if (!r) break;
        this.requests.delete(m.requestId);
        if (r.timer) clearTimeout(r.timer);
        if (m.ok) r.resolve(m.result); else r.reject(new HostError(m.error.code, m.error.message));
        break;
      }
      case "resize": this.viewport = { w: m.w, h: m.h }; this.emit("resize", this.viewport); break;
      case "visibility": this.visible = m.visible; this.emit("visibility", { visible: m.visible }); break;
      case "theme": this.emit("theme", m.theme); break;
      case "fonts": this.loadFonts(m.fontFaces); break;
      case "settings": this.settings = m.settings; this.emit("settings", m.settings); break;
      case "undock": {
        // The host has let go of it already: forget it without telling the host again.
        this.wantedRects = this.wantedRects.filter((r) => r.tileId !== m.tileId);
        this.lastRects = JSON.stringify(this.shownRects());
        this.emit("undock", { tileId: m.tileId });
        break;
      }
      case "reveal": this.answerReveal(m.requestId, m.tileId); break;
      default: break;
    }
  }

  /** The theme's font faces (1.17) in this frame's `document.fonts`, replacing the ones before:
   *  made from bytes, which load where the frame's CSP lets it fetch no font. The family
   *  `theme.fonts` names then draws here; a view does nothing for it. */
  private fontFaces: FontFace[] = [];
  private loadFonts(faces: ViewFontFace[] | undefined): void {
    if (typeof FontFace === "undefined" || typeof document === "undefined" || !areFontFaces(faces ?? [])) return;
    for (const f of this.fontFaces) document.fonts.delete(f);
    this.fontFaces = (faces ?? []).flatMap((f) => {
      try {
        const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
        const face = new FontFace(f.family, bytes, { ...(f.weight ? { weight: f.weight } : {}), ...(f.style ? { style: f.style } : {}) });
        document.fonts.add(face);
        void face.load().catch(() => {});
        return [face];
      } catch { return []; }
    });
  }

  /** The last of each event that says how things are now, which a listener added later is told first. */
  private latest = new Map<string, unknown>();
  private emit(event: string, payload: unknown) {
    if (STATE_EVENTS.has(event)) this.latest.set(event, payload);
    for (const cb of this.listeners.get(event) ?? []) cb(payload);
  }

  private async answerReveal(requestId: number, tileId: string) {
    let rect: ViewRect | null = null;
    try { rect = this.revealHandler ? await this.revealHandler(tileId) : null; } catch { rect = null; }
    this.send({ type: "revealed", requestId, rect });
  }

  private command(name: CommandName, args: unknown[]) {
    const need = COMMAND_PERMISSION[name];
    if (need && !this.capabilities.includes(need)) throw new Error(`hivemind: ${name} needs permission "${need}" — add it to hivemind-view.json`);
    if (name === "spawnAgent") {
      const o = (args[2] ?? {}) as { prompt?: string; resume?: string };
      if (o.prompt !== undefined) this.need("workspace:prompt", "spawnAgent with a prompt");
      if (o.resume !== undefined) this.need("workspace:sessions", "spawnAgent with resume");
      const why = o.prompt === undefined ? null : promptProblem(o.prompt);
      if (why) throw new Error(`hivemind: spawnAgent: ${why}`);
    }
    this.send({ type: "command", name, args });
  }

  on<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb as (p: unknown) => void);
    if (this.latest.has(event)) cb(this.latest.get(event) as EventMap[K]);
    return () => { set!.delete(cb as (p: unknown) => void); };
  }

  get features(): readonly ViewFeature[] { return this.hello.features ?? []; }
  get device(): ViewDevice { return { touch: this.hello.device?.touch === true, compact: this.hello.device?.compact === true }; }
  supports(feature: ViewFeature): boolean { return this.features.includes(feature); }

  onEvents(kinds: readonly ViewEventKind[], cb: (event: ViewEvent) => void, opts: { replaySince?: number } = {}): () => void {
    return this.addEventListener({ kinds: new Set(kinds), custom: [], cb, lastSeq: 0 }, opts.replaySince);
  }

  onCustom(patterns: string | readonly string[], cb: (event: Extract<ViewEvent, { kind: "custom" }>) => void, opts: { replaySince?: number } = {}): () => void {
    const custom = typeof patterns === "string" ? [patterns] : [...patterns];
    return this.addEventListener({ kinds: new Set<ViewEventKind>(["custom"]), custom, cb: cb as (e: ViewEvent) => void, lastSeq: 0 }, opts.replaySince);
  }

  private addEventListener(l: EventListener, replaySince: number | undefined): () => void {
    if (!this.supports("events")) return () => {};
    this.eventListeners.add(l);
    if (replaySince !== undefined) this.pendingReplaySince = Math.min(this.pendingReplaySince ?? replaySince, replaySince);
    this.queueEventSync();
    return () => { if (this.eventListeners.delete(l)) this.queueEventSync(); };
  }

  // One subscription for all listeners, re-sent only when the union changes (or a replay is asked).
  private queueEventSync() {
    if (this.eventSyncQueued) return;
    this.eventSyncQueued = true;
    queueMicrotask(() => {
      this.eventSyncQueued = false;
      const kinds = new Set<ViewEventKind>();
      const custom = new Set<string>();
      for (const l of this.eventListeners) { for (const k of l.kinds) kinds.add(k); for (const p of l.custom) custom.add(p); }
      const replaySince = this.pendingReplaySince;
      this.pendingReplaySince = undefined;
      if (kinds.size === 0) {
        if (this.lastEventSubscription) { this.lastEventSubscription = ""; this.send({ type: "unsubscribeEvents" }); }
        return;
      }
      const msg = { type: "subscribeEvents" as const, kinds: [...kinds].sort(), ...(custom.size ? { custom: [...custom].sort() } : {}) };
      const key = JSON.stringify(msg);
      if (key === this.lastEventSubscription && replaySince === undefined) return;
      this.lastEventSubscription = key;
      this.send(replaySince === undefined ? msg : { ...msg, replaySince });
    });
  }

  activity(tileId: string, cb: (level: ActivityLevel) => void): () => void {
    if (!this.supports("activity")) return () => {};
    let set = this.activityCbs.get(tileId);
    if (!set) { this.activityCbs.set(tileId, (set = new Set())); this.queueActivitySync(); }
    set.add(cb);
    return () => {
      const s = this.activityCbs.get(tileId);
      if (!s?.delete(cb) || s.size > 0) return;
      this.activityCbs.delete(tileId);
      this.queueActivitySync();
    };
  }

  private queueActivitySync() {
    if (this.activitySyncQueued) return;
    this.activitySyncQueued = true;
    queueMicrotask(() => {
      this.activitySyncQueued = false;
      const tileIds = [...this.activityCbs.keys()].sort();
      const key = tileIds.join("\n");
      if (key === this.lastWatched) return;
      this.lastWatched = key;
      this.send({ type: "watchActivity", tileIds });
    });
  }

  onPresence(cb: (presence: ViewPresence) => void): () => void {
    if (!this.supports("presence")) return () => {};
    this.presenceCbs.add(cb);
    if (this.presenceCbs.size === 1) this.send({ type: "subscribePresence" });
    else if (this.presence) cb(this.presence);
    return () => {
      if (this.presenceCbs.delete(cb) && this.presenceCbs.size === 0) { this.presence = null; this.send({ type: "unsubscribePresence" }); }
    };
  }

  onParticipants(cb: (participants: ViewParticipant[]) => void): () => void {
    if (!this.supports("participants")) return () => {};
    this.participantCbs.add(cb);
    if (this.participantCbs.size === 1) this.send({ type: "subscribeParticipants" });
    else if (this.participants) cb(this.participants);
    return () => {
      if (this.participantCbs.delete(cb) && this.participantCbs.size === 0) { this.participants = null; this.send({ type: "unsubscribeParticipants" }); }
    };
  }

  onWidgets(cb: (widgets: ViewWidget[]) => void): () => void {
    if (!this.supports("widgets")) return () => {};
    this.widgetCbs.add(cb);
    if (this.widgetCbs.size === 1) this.send({ type: "subscribeWidgets" });
    else if (this.widgets) cb(this.widgets);
    return () => {
      if (this.widgetCbs.delete(cb) && this.widgetCbs.size === 0) { this.widgets = null; this.send({ type: "unsubscribeWidgets" }); }
    };
  }

  /** The declared commands' keys, run here while focus is in this frame; the host runs them elsewhere. */
  private bindKeys(keys: CommandKeys[] | undefined) {
    if (!keys?.length || typeof globalThis.addEventListener !== "function") return;
    const mac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
    globalThis.addEventListener("keydown", (e) => {
      const bound = keys.find((k) => chordMatches(k.keys, e as KeyboardEvent, mac));
      const handler = bound && this.commandHandlers.get(bound.command);
      if (!handler) return;
      e.preventDefault();
      void Promise.resolve().then(() => handler(null)).catch(() => {});
    });
  }

  onCommand(name: string, handler: (args: unknown) => unknown): () => void {
    this.commandHandlers.set(name, handler);
    return () => { if (this.commandHandlers.get(name) === handler) this.commandHandlers.delete(name); };
  }

  private async answer(invokeId: number, name: string, args: unknown) {
    // A plugin registers its handlers just after it connects: a call that arrives first waits for one.
    for (let waited = 0; !this.commandHandlers.has(name) && waited < HANDLER_WAIT_MS; waited += 50) await new Promise((r) => setTimeout(r, 50));
    const handler = this.commandHandlers.get(name);
    if (!handler) { this.send({ type: "invokeResult", invokeId, ok: false, error: `it does not answer "${name}" now` }); return; }
    try {
      const result = JSON.parse(JSON.stringify((await handler(args)) ?? null)) as unknown;
      this.send({ type: "invokeResult", invokeId, ok: true, result });
    } catch (e) {
      this.send({ type: "invokeResult", invokeId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  onIssues(cb: (issues: ViewIssueSummary[]) => void): () => void {
    this.need("workspace:issues", "onIssues");
    if (!this.supports("issues")) return () => {};
    this.issueCbs.add(cb);
    if (this.issueCbs.size === 1) this.send({ type: "subscribeIssues" });
    else if (this.issueList) cb(this.issueList);
    return () => {
      if (this.issueCbs.delete(cb) && this.issueCbs.size === 0) { this.issueList = null; this.send({ type: "unsubscribeIssues" }); }
    };
  }

  private issueCall(call: IssueCall, args: unknown[]): Promise<unknown> {
    this.need("workspace:issues", `issues.${call}`);
    if (!this.supports("issues")) return Promise.reject(new HostError("UNSUPPORTED", "this host has no issues"));
    return this.request((requestId) => ({ type: "request", requestId, name: "issue", args: [{ call, args }] }), 30_000);
  }

  pressWidget(id: string, action: unknown): void {
    this.need("workspace:widgets", "pressWidget");
    if (this.supports("widgets")) this.send({ type: "pressWidget", id, action });
  }

  clickWidget(id: string): void {
    this.need("workspace:widgets", "clickWidget");
    if (this.supports("widgets")) this.send({ type: "pressWidget", id, click: true });
  }

  private need(p: ViewPermission, what: string) {
    if (!this.capabilities.includes(p)) throw new Error(`hivemind: ${what} needs permission "${p}" — add it to hivemind-view.json`);
  }

  agents(): Promise<ViewAgent[]> {
    if (!this.supports("agents")) return Promise.reject(new HostError("UNSUPPORTED", "this host does not list agents"));
    return this.request((requestId) => ({ type: "request", requestId, name: "agents", args: [{}] }), 10_000).then((r) => (r as { agents: ViewAgent[] }).agents);
  }

  sessions(agent: string, frameId: string): Promise<ViewSession[]> {
    this.need("workspace:sessions", "sessions");
    if (!this.supports("sessions")) return Promise.reject(new HostError("UNSUPPORTED", "this host does not list sessions"));
    return this.request((requestId) => ({ type: "request", requestId, name: "sessions", args: [{ agent, frameId }] }), 30_000).then((r) => (r as { sessions: ViewSession[] }).sessions);
  }

  prompt(tileId: string, text: string): Promise<PromptOutcome> {
    this.need("workspace:prompt", "prompt");
    if (!this.supports("prompt")) return Promise.reject(new HostError("UNSUPPORTED", "this host cannot prompt agents"));
    const why = promptProblem(text);
    if (why) return Promise.reject(new HostError("BAD_REQUEST", why));
    // No timeout: the user may be reading the prompt.
    return this.request((requestId) => ({ type: "request", requestId, name: "prompt", args: [{ tileId, text }] })).then((r) => (r as { outcome: PromptOutcome }).outcome);
  }

  history(day: string): Promise<ViewHistoryDay> {
    if (!this.supports("history")) return Promise.reject(new HostError("UNSUPPORTED", "this host has no history"));
    return this.request((requestId) => ({ type: "request", requestId, name: "history", args: [{ day }] }), 10_000) as Promise<ViewHistoryDay>;
  }

  share(png: ArrayBuffer, opts: { suggestedName?: string } = {}): Promise<ShareOutcome> {
    if (!this.supports("share")) return Promise.reject(new HostError("UNSUPPORTED", "this host cannot share images"));
    // No timeout: the user may be looking at the dialog.
    return this.request((requestId) => ({ type: "request", requestId, name: "share", args: [{ png, ...(opts.suggestedName ? { suggestedName: opts.suggestedName } : {}) }] }), undefined, [png])
      .then((r) => (r as { outcome: ShareOutcome }).outcome);
  }

  private request(make: (id: number) => PluginMessage, timeoutMs?: number, transfer: Transferable[] = []): Promise<unknown> {
    const requestId = this.nextRequest++;
    return new Promise((resolve, reject) => {
      const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
      if (timeoutMs) entry.timer = setTimeout(() => { this.requests.delete(requestId); reject(new HostError("INTERNAL", "the host did not answer")); }, timeoutMs);
      this.requests.set(requestId, entry);
      this.send(make(requestId), transfer);
    });
  }

  subscribeStatus(tileId: string, cb: (status: ViewStatus, info?: StatusInfo) => void): () => void {
    let set = this.status.get(tileId);
    if (!set) { this.status.set(tileId, (set = new Set())); this.send({ type: "subscribeStatus", tileId }); }
    set.add(cb);
    return () => {
      const s = this.status.get(tileId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) { this.status.delete(tileId); this.send({ type: "unsubscribeStatus", tileId }); }
    };
  }

  setSurfaceRects(rects: SurfaceRect[]) {
    this.wantedRects = rects.map((r) => ({ tileId: r.tileId, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h),
      ...(r.chrome ? { chrome: r.chrome } : {}), ...(r.radius ? { radius: r.radius } : {}), ...(r.inert ? { inert: true as const } : {}) }));
    this.sendRects();
  }

  setLineRects(rects: LineRect[]) {
    this.wantedLines = rects.map((r) => ({ tileId: r.tileId, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }));
    this.sendLines();
  }

  private sendLines() {
    if (!this.supports("lineSlots")) return;
    const rects = this.wantedLines.filter((r) => this.tiles.has(r.tileId));
    const key = JSON.stringify(rects);
    if (key === this.lastLines) return;
    this.lastLines = key;
    this.send({ type: "lineRects", rects });
  }

  // A tile the host has not named (one from a saved layout that is gone, or not heard of yet) is
  // held back: the host refuses a rect for a tile it does not have, and enough refusals disable
  // the view.
  private shownRects(): SurfaceRect[] { return this.wantedRects.filter((r) => this.tiles.has(r.tileId)); }

  private sendRects() {
    const rects = this.shownRects();
    const key = JSON.stringify(rects);
    if (key === this.lastRects) return;
    this.lastRects = key;
    this.send({ type: "surfaceRects", rects });
  }

  onReveal(handler: (tileId: string) => ViewRect | null | Promise<ViewRect | null>) {
    this.revealHandler = handler;
    return () => { if (this.revealHandler === handler) this.revealHandler = null; };
  }

  reportFrame() {
    this.framesDrawn++;
    if (this.frameTimer) return;
    // Trailing throttle: at most one report per second, always the latest count.
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      if (this.framesDrawn !== this.lastReportedFrames) { this.lastReportedFrames = this.framesDrawn; this.send({ type: "framesDrawn", count: this.framesDrawn }); }
    }, 1000);
  }

  setLayout(data: unknown, opts?: { now?: boolean }) {
    this.pendingLayout = { data };
    if (opts?.now) { this.flushLayout(); return; }
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => this.flushLayout(), 250);
  }

  private flushLayout() {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = null;
    const pending = this.pendingLayout;
    this.pendingLayout = null;
    if (pending) this.send({ type: "layout", data: pending.data });
  }

  error(message: string) { this.send({ type: "error", message }); }
}

/**
 * Render-on-demand helper: coalesces any number of `invalidate()` calls into
 * ONE animation frame, draws nothing while the host says the view is hidden
 * (one catch-up frame when it returns), and counts every drawn frame on the
 * client. The same rule the built-in World view keeps.
 */
export function createInvalidator(client: ViewClient, draw: () => void): { invalidate: () => void; dispose: () => void } {
  let pending = false;
  let dirtyWhileHidden = false;
  const tick = () => {
    pending = false;
    if (!client.visible) { dirtyWhileHidden = true; return; }
    draw();
    client.reportFrame();
  };
  const invalidate = () => {
    if (pending) return;
    if (!client.visible) { dirtyWhileHidden = true; return; }
    pending = true;
    requestAnimationFrame(tick);
  };
  const off = client.on("visibility", ({ visible }) => { if (visible && dirtyWhileHidden) { dirtyWhileHidden = false; invalidate(); } });
  return { invalidate, dispose: off };
}

/**
 * Map the host theme to CSS custom properties on `root` (default: the plugin
 * document's <html>) and keep them updated on every `theme` message:
 *
 *   --hm-color-<token>   every `colors` entry (bg, bg2, fg, brand, ok, …)
 *   --hm-accent          --hm-radius (px)   --hm-font-ui   --hm-font-mono
 *   --hm-surface         --hm-terminal-bg   --hm-glass (0 | 1)   --hm-mode
 *   --hm-color-scheme    (dark | light — put it on panels that scroll, never on the root)
 *   --hm-token-<id>      (1.16: each of the view's own tokens, its manifest's `tokens`)
 *
 * So a plugin's CSS can say `background: var(--hm-color-bg2)` and follow the
 * user's appearance without reading messages itself. Returns the unsubscribe.
 */
export function applyThemeVars(client: ViewClient, root: HTMLElement = document.documentElement): () => void {
  const set = new Set<string>();
  const apply = (t: ViewTheme) => {
    for (const [k, v] of Object.entries(t.colors)) root.style.setProperty(`--hm-color-${k}`, v);
    // Status tones: the host's, or — from a host that predates them — the same meanings derived
    // from its palette, so `--hm-status-*` always exists and a view never maps statuses itself.
    const derived: Record<StatusTone, string | undefined> = {
      working: t.colors.brand, attention: t.colors.warn, done: t.colors.ok,
      idle: t.colors.fg3, exited: t.colors.fg3, failed: t.colors.err,
    };
    const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
    for (const tone of STATUS_TONES) {
      // A value that is not a colour falls through to the derived one: a tone is never left unset.
      const v = [t.status?.[tone], derived[tone]].find(isHex);
      if (v) root.style.setProperty(`--hm-status-${tone}`, v);
    }
    if (t.accent) root.style.setProperty("--hm-accent", t.accent);
    if (t.radius !== undefined) root.style.setProperty("--hm-radius", `${t.radius}px`);
    if (t.fonts) { root.style.setProperty("--hm-font-ui", t.fonts.ui); root.style.setProperty("--hm-font-mono", t.fonts.mono); }
    if (t.surface) root.style.setProperty("--hm-surface", t.surface);
    if (t.terminalBackground) root.style.setProperty("--hm-terminal-bg", t.terminalBackground);
    if (t.glass !== undefined) root.style.setProperty("--hm-glass", t.glass ? "1" : "0");
    // The view's own tokens; one the theme no longer sends goes, so its `var()` fallback shows.
    const tokens = Object.entries(t.tokens ?? {}).filter(([k, v]) => isTokenId(k) && /^#[0-9a-f]{6}$/i.test(v));
    for (const k of set) if (!tokens.some(([id]) => id === k)) root.style.removeProperty(tokenVar(k));
    set.clear();
    for (const [k, v] of tokens) { root.style.setProperty(tokenVar(k), v); set.add(k); }
    if (t.mode) {
      root.style.setProperty("--hm-mode", t.mode);
      root.dataset.hmMode = t.mode;
      // The user's wallpaper is painted BEHIND the view, so the view's frame has to stay
      // see-through. A `color-scheme` on the ROOT makes the browser paint the frame's base
      // canvas opaque even when the background is transparent, which hides it — so the root
      // keeps `normal`, and the scheme rides on a token for the panels that scroll.
      root.style.setProperty("--hm-color-scheme", t.mode);
      root.style.colorScheme = "normal";
      root.style.background = "transparent";
    }
  };
  apply(client.hello.theme);
  return client.on("theme", apply);
}
