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
  COMMAND_PERMISSION, PORT_HANDSHAKE, PROTOCOL_VERSION, parseHostMessage,
  type CommandName, type HostMessage, type PluginMessage, type SurfaceRect, type ViewCommands, type ViewPermission, type ViewRect, type ViewStatus,
} from "./protocol.js";

type Hello = Extract<HostMessage, { type: "hello" }>;
type EventMap = {
  structure: Extract<HostMessage, { type: "structure" }>;
  names: Extract<HostMessage, { type: "names" }>;
  selection: Extract<HostMessage, { type: "selection" }>;
  resize: { w: number; h: number };
  visibility: { visible: boolean };
  theme: Extract<HostMessage, { type: "theme" }>["theme"];
};

export interface ViewClient {
  readonly hello: Hello;
  readonly capabilities: readonly ViewPermission[];
  /** Latest viewport size / visibility as told by the host. */
  readonly viewport: { w: number; h: number };
  readonly visible: boolean;
  on<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): () => void;
  /** Per-tile status. Subscribes on first listener, unsubscribes on last. */
  subscribeStatus(tileId: string, cb: (status: ViewStatus) => void): () => void;
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

class Client implements ViewClient {
  hello!: Hello;
  capabilities: readonly ViewPermission[] = [];
  viewport = { w: 0, h: 0 };
  visible = true;
  framesDrawn = 0;
  readonly commands: ViewCommands;
  private listeners = new Map<string, Set<(p: unknown) => void>>();
  private status = new Map<string, Set<(s: ViewStatus) => void>>();
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

  private send(msg: PluginMessage) { this.port.postMessage(msg); }

  private dispatch(m: HostMessage) {
    switch (m.type) {
      case "structure": case "names": case "selection": this.emit(m.type, m); break;
      case "status": for (const cb of this.status.get(m.tileId) ?? []) cb(m.status); break;
      case "resize": this.viewport = { w: m.w, h: m.h }; this.emit("resize", this.viewport); break;
      case "visibility": this.visible = m.visible; this.emit("visibility", { visible: m.visible }); break;
      case "theme": this.emit("theme", m.theme); break;
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

  subscribeStatus(tileId: string, cb: (status: ViewStatus) => void): () => void {
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
    const norm = rects.map((r) => ({ tileId: r.tileId, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }));
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
