/** One PTY daemon connection over any transport: attach, stream, and re-attach live tiles after a drop. */
import type { Duplex } from "node:stream";
import { type ClientMsg, type ServerMsg, type SessionInfo, frame, makeLineDecoder } from "./pty-protocol.js";

export interface SpawnOpts {
  tileId: string;
  cwd: string;
  cmd: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** Attach to an existing session only; never start one. */
  noSpawn?: boolean;
  /** With noSpawn: a running session only; one saved before a reboot is not restored. */
  liveOnly?: boolean;
}
export interface Callbacks {
  onData: (data: string) => void;
  onExit: (code: number, signal: number | undefined) => void;
}
type AttachSpec = Extract<ClientMsg, { t: "attach" }>["spec"];

/** The tile still shows the pre-drop screen, so a re-attach replay starts from a full reset. */
export const REATTACH_RESET = "\x1bc";

export interface EndpointOptions {
  /** Open a fresh transport to the daemon; reject when it is unreachable. */
  connect: () => Promise<Duplex>;
  retryInitialMs?: number;
  retryMaxMs?: number;
  attachTimeoutMs?: number;
  /** Agent hook events from a daemon that runs without the desktop. */
  onEvent?: (topic: string, data: unknown) => void;
  /** Transport state; `reconnecting` carries ssh's reason while tiles wait for it. */
  onStatus?: (state: EndpointState, detail?: string) => void;
  /** A connect failure no retry can fix (login, host key): wait for `reconnectNow` instead of retrying. */
  isFatal?: (message: string) => boolean;
  /** The user turned the machine off: stay disconnected, keep the tiles, until `reconnectNow`. */
  isPaused?: () => boolean;
}

export type EndpointState = "connecting" | "online" | "reconnecting" | "idle";

export class DaemonEndpoint {
  private conn: Duplex | null = null;
  private connecting: Promise<Duplex> | null = null;
  private readonly cbs = new Map<string, Callbacks>();
  private readonly specs = new Map<string, AttachSpec>();
  private readonly pending = new Map<string, (r: { pid: number }) => void>();
  /** Where each tile's output stands, so a re-attach asks only for what it missed. */
  private readonly pos = new Map<string, { seq: number; epoch: string }>();
  /** Tiles whose session exists in the daemon: a re-attach must never start them again. */
  private readonly live = new Set<string>();
  private readonly replies = new Map<string, (msg: ServerMsg) => void>();
  private seq = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closed = false;
  private state: EndpointState = "idle";

  constructor(private readonly o: EndpointOptions) {}

  private status(state: EndpointState, detail?: string): void {
    this.state = state;
    this.o.onStatus?.(state, detail);
  }

  get connected(): boolean { return !!this.conn && !this.conn.destroyed; }
  /** Tiles this connection serves. */
  get tiles(): number { return this.cbs.size; }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case "attached": {
        if (msg.error && (msg.reqId.startsWith("re") || this.live.has(msg.id))) {
          const cb = this.cbs.get(msg.id);
          this.forget(msg.id);
          // Gone while we were away (exited, or killed by another viewer).
          if (msg.reqId.startsWith("re")) { cb?.onExit(0, 1); break; }
        }
        if (msg.pid > 0) this.live.add(msg.id);
        if (msg.seq !== undefined && msg.epoch) this.pos.set(msg.id, { seq: msg.seq, epoch: msg.epoch });
        // A delta continues the stream exactly; a redraw of a tile that shows the old screen starts from a reset.
        const redraw = msg.reqId.startsWith("re") && !msg.delta;
        if (msg.replay) this.cbs.get(msg.id)?.onData(redraw ? REATTACH_RESET + msg.replay : msg.replay);
        const resolve = this.pending.get(msg.reqId);
        if (resolve) { this.pending.delete(msg.reqId); resolve({ pid: msg.pid }); }
        break;
      }
      case "data": {
        const p = this.pos.get(msg.id);
        if (p && msg.seq !== undefined) p.seq = msg.seq;
        this.cbs.get(msg.id)?.onData(msg.data);
        break;
      }
      case "resync":
        this.pos.set(msg.id, { seq: msg.seq, epoch: msg.epoch });
        this.cbs.get(msg.id)?.onData(REATTACH_RESET + msg.replay);
        break;
      case "event":
        this.o.onEvent?.(msg.topic, msg.data);
        break;
      case "pong":
      case "sessions": {
        const reply = this.replies.get(msg.reqId);
        if (reply) { this.replies.delete(msg.reqId); reply(msg); }
        break;
      }
      case "exit": {
        const cb = this.cbs.get(msg.id);
        this.forget(msg.id);
        cb?.onExit(msg.code, msg.signal ?? undefined);
        break;
      }
      default:
        break;
    }
  }

  private setup(s: Duplex): void {
    this.conn = s;
    this.status("online");
    s.write(frame({ t: "hello", caps: this.o.onEvent ? ["resync", "events"] : ["resync"] }));
    s.on("data", makeLineDecoder(
      (line) => { try { this.handle(JSON.parse(line) as ServerMsg); } catch { /* not a protocol line */ } },
      () => { this.status("reconnecting", "the daemon sent a line that never ended"); s.destroy(); },
    ));
    s.on("close", () => {
      if (this.conn === s) this.conn = null;
      // Fail in-flight attaches now rather than after their timeout.
      for (const [reqId, resolve] of [...this.pending]) { this.pending.delete(reqId); resolve({ pid: -1 }); }
      if (this.closed) return;
      if (this.o.isPaused?.()) { this.status("idle"); return; }
      this.status(this.cbs.size ? "reconnecting" : "idle");
      this.scheduleReattach();
    });
    s.on("error", () => { /* surfaced as close */ });
  }

  private ensure(): Promise<Duplex> {
    if (this.conn && !this.conn.destroyed) return Promise.resolve(this.conn);
    if (this.closed) return Promise.reject(new Error("endpoint closed"));
    if (this.o.isPaused?.()) return Promise.reject(new Error("turned off"));
    if (!this.connecting) {
      // A retry is still "reconnecting": flipping to "connecting" each attempt would flicker the UI.
      if (this.state !== "reconnecting") this.status("connecting");
      this.connecting = this.o.connect()
        .then((s) => { this.setup(s); return s; })
        .catch((e: unknown) => {
          // Say why, even when no tile is waiting: otherwise the machine reads "connecting" forever.
          this.status(this.cbs.size ? "reconnecting" : "idle", e instanceof Error ? e.message : String(e));
          throw e;
        })
        .finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  private async send(msg: ClientMsg): Promise<void> {
    (await this.ensure()).write(frame(msg));
  }

  private fire(msg: ClientMsg): void {
    this.send(msg).catch(() => { /* unreachable: re-attach retries on its own */ });
  }

  private scheduleReattach(): void {
    if (this.retry || this.closed || this.cbs.size === 0 || this.o.isPaused?.()) return;
    const base = this.o.retryInitialMs ?? 250;
    const max = this.o.retryMaxMs ?? 30_000;
    // Jittered, so several machines dropped by one network blip don't reconnect in lockstep.
    const wait = this.attempts === 0 ? 0 : Math.min(max, base * 2 ** (this.attempts - 1)) * (0.5 + Math.random() / 2);
    this.retry = setTimeout(() => { this.retry = null; void this.reattach(); }, wait);
    this.retry.unref?.();
  }

  private async reattach(): Promise<void> {
    try {
      const c = await this.ensure();
      this.attempts = 0;
      for (const [id, spec] of this.specs) {
        if (!this.cbs.has(id)) continue;
        const since = this.pos.get(id);
        c.write(frame({ t: "attach", reqId: `re${++this.seq}`, id, spec, ...(since ? { since } : {}), ...(this.live.has(id) ? { noSpawn: true } : {}) }));
      }
    } catch (e) {
      this.attempts++;
      const msg = e instanceof Error ? e.message : String(e);
      this.status("reconnecting", msg);
      if (!this.o.isFatal?.(msg)) this.scheduleReattach();
    }
  }

  /** Drop the connection without closing: the tiles stay, and `reconnectNow` brings them back. */
  disconnect(): void {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.conn?.destroy();
  }

  /** Skip the backoff wait (the user asked, or the network came back). */
  reconnectNow(): void {
    if (this.closed || this.cbs.size === 0 || (this.conn && !this.conn.destroyed)) return;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.attempts = 0;
    void this.reattach();
  }

  private request<T extends ServerMsg>(msg: ClientMsg & { reqId: string }, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.replies.delete(msg.reqId); reject(new Error("the daemon did not answer")); }, timeoutMs);
      timer.unref?.();
      this.replies.set(msg.reqId, (m) => { clearTimeout(timer); resolve(m as T); });
      this.send(msg).catch((e: unknown) => { clearTimeout(timer); this.replies.delete(msg.reqId); reject(e); });
    });
  }

  /** Round trip to the daemon in ms, over the existing connection only. */
  async ping(timeoutMs = 10_000): Promise<number> {
    if (!this.conn || this.conn.destroyed) throw new Error("not connected");
    const t0 = performance.now();
    await this.request({ t: "ping", reqId: `p${++this.seq}` }, timeoutMs);
    return Math.round(performance.now() - t0);
  }

  /** Every session in the daemon, connecting if needed. */
  async sessions(timeoutMs = 15_000): Promise<SessionInfo[]> {
    const r = await this.request<Extract<ServerMsg, { t: "sessions" }>>({ t: "list", reqId: `l${++this.seq}`, detail: true }, timeoutMs);
    return r.detail ?? [];
  }

  async spawn(opts: SpawnOpts, cb: Callbacks): Promise<{ pid: number }> {
    this.cbs.set(opts.tileId, cb);
    const spec: AttachSpec = { cwd: opts.cwd, cmd: opts.cmd, args: opts.args ?? [], cols: opts.cols, rows: opts.rows, env: opts.env };
    this.specs.set(opts.tileId, spec);
    if (opts.noSpawn) this.live.add(opts.tileId);
    const reqId = `a${++this.seq}`;
    const result = new Promise<{ pid: number }>((resolve) => {
      this.pending.set(reqId, resolve);
      const t = setTimeout(() => { if (this.pending.delete(reqId)) resolve({ pid: -1 }); }, this.o.attachTimeoutMs ?? 6000);
      t.unref?.();
    });
    try {
      await this.send({ t: "attach", reqId, id: opts.tileId, spec, ...(opts.noSpawn ? { noSpawn: true } : {}), ...(opts.liveOnly ? { liveOnly: true } : {}) });
    } catch (e) {
      // Unreachable now (e.g. offline): keep retrying so the tile attaches once it is back.
      const msg = e instanceof Error ? e.message : String(e);
      this.status("reconnecting", msg);
      if (!this.o.isFatal?.(msg)) this.scheduleReattach();
      if (this.pending.delete(reqId)) return { pid: -1 };
    }
    return result;
  }

  has(tileId: string): boolean { return this.specs.has(tileId); }
  write(tileId: string, data: string): void { this.fire({ t: "write", id: tileId, data }); }
  resize(tileId: string, cols: number, rows: number): void { this.fire({ t: "resize", id: tileId, cols, rows }); }
  pause(tileId: string): void { this.fire({ t: "pause", id: tileId }); }
  resume(tileId: string): void { this.fire({ t: "resume", id: tileId }); }

  /** Terminate the session in the daemon. */
  kill(tileId: string): void {
    this.forget(tileId);
    this.fire({ t: "kill", id: tileId });
  }
  /** Stop streaming but keep the session running in the daemon. */
  detach(tileId: string): void {
    this.forget(tileId);
    this.fire({ t: "detach", id: tileId });
  }
  private forget(tileId: string): void {
    this.cbs.delete(tileId);
    this.specs.delete(tileId);
    this.pos.delete(tileId);
    this.live.delete(tileId);
  }

  /** Drop the transport and stop reconnecting; sessions keep running in the daemon. */
  close(): void {
    this.closed = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const c = this.conn;
    this.conn = null;
    try { c?.destroy(); } catch { /* already gone */ }
  }
}
