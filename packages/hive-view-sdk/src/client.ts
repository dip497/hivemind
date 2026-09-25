/**
 * The plugin-side client. A community view calls `connect()` once, then talks
 * to hivemind through typed methods and events — never `postMessage` directly.
 *
 *   const hm = await connect();
 *   hm.on("structure", ({ frames, tiles }) => rebuild(frames, tiles));
 *   const off = hm.subscribeStatus(tileId, (s) => paint(tileId, s));
 *   hm.commands.selectTile(tileId);
 *   hm.setSurfaceRects([{ tileId, x, y, w, h }]);   // a live terminal appears here
 *
 * The host hands the MessagePort over with a `PORT_HANDSHAKE` window message
 * right after the iframe loads; `connect()` resolves once `hello` arrives.
 */
import {
  COMMAND_PERMISSION, PORT_HANDSHAKE, PROTOCOL_VERSION, STATUS_TONES, customNameMatches, parseHostMessage,
  type ActivityLevel, type CommandName, type HostMessage, type PluginMessage, type RequestErrorCode, type ShareOutcome, type StatusTone, type SurfaceRect,
  type ViewCommands, type ViewEvent, type ViewEventKind, type ViewFeature, type ViewHistoryDay, type ViewPermission, type ViewPresence, type ViewRect, type ViewStatus, type ViewTheme,
} from "./protocol.js";

/** A request the host refused or could not answer (`UNSUPPORTED` when it lacks the feature). */
export class HostError extends Error {
  constructor(readonly code: RequestErrorCode, message: string) { super(message); this.name = "HostError"; }
}

/** 1.3: what arrives with a status — absent from a host that predates it. */
export interface StatusInfo { since?: number; exact?: boolean }

type Hello = Extract<HostMessage, { type: "hello" }>;
type EventMap = {
  structure: Extract<HostMessage, { type: "structure" }>;
  names: Extract<HostMessage, { type: "names" }>;
  selection: Extract<HostMessage, { type: "selection" }>;
  resize: { w: number; h: number };
  visibility: { visible: boolean };
  theme: Extract<HostMessage, { type: "theme" }>["theme"];
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
  /** 1.3: per-tile status intervals for a local day (YYYY-MM-DD). */
  history(day: string): Promise<ViewHistoryDay>;
  /** 1.3: ask the user to copy or save this PNG; resolves with what they chose. */
  share(png: ArrayBuffer, opts?: { suggestedName?: string }): Promise<ShareOutcome>;
  /** Typed commands; one the manifest did not request throws locally. */
  readonly commands: ViewCommands;
  /** The hole-punch — deduplicated: identical rects are not re-sent. */
  setSurfaceRects(rects: SurfaceRect[]): void;
  /** The host asked to reveal a tile; answer with where it is (or null). */
  onReveal(handler: (tileId: string) => ViewRect | null | Promise<ViewRect | null>): () => void;
  /** Count a drawn frame (reported to the host, throttled). */
  reportFrame(): void;
  readonly framesDrawn: number;
  /** Persist an opaque blob under the plugin id (debounced). */
  setLayout(data: unknown): void;
  /** Report a non-fatal problem to the host log. */
  error(message: string): void;
}

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

interface EventListener { kinds: Set<ViewEventKind>; custom: string[]; cb: (e: ViewEvent) => void; lastSeq: number }

class Client implements ViewClient {
  hello!: Hello;
  capabilities: readonly ViewPermission[] = [];
  viewport = { w: 0, h: 0 };
  visible = true;
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
  private requests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private nextRequest = 1;
  private revealHandler: ((tileId: string) => ViewRect | null | Promise<ViewRect | null>) | null = null;
  private lastRects = "";
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReportedFrames = 0;
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private ready: Promise<void>;

  constructor(private port: MessagePort) {
    this.commands = Object.fromEntries(
      (Object.keys(COMMAND_PERMISSION) as CommandName[]).map((name) => [name, (...args: unknown[]) => this.command(name, args)]),
    ) as unknown as ViewCommands;
    this.ready = new Promise<void>((res) => {
      port.onmessage = (e) => {
        const r = parseHostMessage(e.data);
        if (!r.ok) return;
        if (r.msg.type === "hello") { this.hello = r.msg; this.capabilities = r.msg.capabilities; this.viewport = { ...r.msg.viewport }; this.visible = r.msg.visible; res(); return; }
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
      case "structure": case "names": case "selection": this.emit(m.type, m); break;
      case "status": {
        const info: StatusInfo | undefined = m.since === undefined ? undefined : { since: m.since, ...(m.exact === undefined ? {} : { exact: m.exact }) };
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
      case "undock": {
        try { const kept = (JSON.parse(this.lastRects || "[]") as SurfaceRect[]).filter((r) => r.tileId !== m.tileId); this.lastRects = JSON.stringify(kept); } catch { this.lastRects = ""; }
        this.emit("undock", { tileId: m.tileId });
        break;
      }
      case "reveal": this.answerReveal(m.requestId, m.tileId); break;
      default: break;
    }
  }

  private emit(event: string, payload: unknown) { for (const cb of this.listeners.get(event) ?? []) cb(payload); }

  private async answerReveal(requestId: number, tileId: string) {
    let rect: ViewRect | null = null;
    try { rect = this.revealHandler ? await this.revealHandler(tileId) : null; } catch { rect = null; }
    this.send({ type: "revealed", requestId, rect });
  }

  private command(name: CommandName, args: unknown[]) {
    const need = COMMAND_PERMISSION[name];
    if (need && !this.capabilities.includes(need)) throw new Error(`hivemind: ${name} needs permission "${need}" — add it to hivemind-view.json`);
    this.send({ type: "command", name, args });
  }

  on<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb as (p: unknown) => void);
    return () => { set!.delete(cb as (p: unknown) => void); };
  }

  get features(): readonly ViewFeature[] { return this.hello.features ?? []; }
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
    const norm = rects.map((r) => ({ tileId: r.tileId, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), ...(r.chrome ? { chrome: r.chrome } : {}) }));
    const key = JSON.stringify(norm);
    if (key === this.lastRects) return;
    this.lastRects = key;
    this.send({ type: "surfaceRects", rects: norm });
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

  setLayout(data: unknown) {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => { this.layoutTimer = null; this.send({ type: "layout", data }); }, 250);
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
 *
 * So a plugin's CSS can say `background: var(--hm-color-bg2)` and follow the
 * user's appearance without reading messages itself. Returns the unsubscribe.
 */
export function applyThemeVars(client: ViewClient, root: HTMLElement = document.documentElement): () => void {
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
