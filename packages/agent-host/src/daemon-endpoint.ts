/** One PTY daemon connection over any transport: attach, stream, and re-attach live tiles after a drop. */
import type { Duplex } from "node:stream";
import { type ClientMsg, type ServerMsg, type SessionInfo, NothingAsleep, frame, makeLineDecoder } from "./pty-protocol.js";
import { agentPackageFor } from "./agent-package.js";

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
  /** At most this many lines of scrollback in the replay of a running session. */
  lines?: number;
  /** A session put to sleep is restored (its agent resumed); without it, one is answered `asleep`. */
  wake?: boolean;
}

/** How long a sleep or a wake is waited for: an agent may take seconds to end, or to resume. */
const WAKE_TIMEOUT_MS = 30_000;
/** While an attach waits for its answer, how often the daemon is asked whether it is still there,
 *  and how long it has to say so. */
const STILL_THERE_EVERY_MS = 5_000;
const STILL_THERE_WAIT_MS = 10_000;
/** How long a sleeping session's saved screen is waited for. */
const SAVED_TIMEOUT_MS = 10_000;

/** What an attach came to: `pid` -1 when nothing runs, `asleep` when that is because it sleeps,
 *  `error` why it did not open when something went wrong. */
export interface Attached { pid: number; asleep?: true; error?: string }
export interface Callbacks {
  /** `replay`: a redraw of output already seen, not new output. */
  onData: (data: string, replay?: boolean) => void;
  /** `slept`: it was put to sleep (`sleep`), not ended: an attach brings it back. */
  onExit: (code: number, signal: number | undefined, slept?: boolean) => void;
  /** The session's size, as its daemon says it on attaching and whenever it changes. */
  onSize?: (cols: number, rows: number) => void;
}
type AttachSpec = Extract<ClientMsg, { t: "attach" }>["spec"];

/** The tile still shows the pre-drop screen, so a re-attach replay starts from a full reset. */
export const REATTACH_RESET = "\x1bc";

/** The daemon answered a claim on its control-plane socket with a refusal. */
export class ControlRefused extends Error {}

export interface EndpointOptions {
  /** Open a fresh transport to the daemon; reject when it is unreachable. */
  connect: () => Promise<Duplex>;
  /** The environment sessions this endpoint starts begin from, as it is now. */
  env?: () => Record<string, string>;
  retryInitialMs?: number;
  retryMaxMs?: number;
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
  private readonly pending = new Map<string, (r: Attached & { error?: string; gone?: true }) => void>();
  /** Where each tile's output stands, so a re-attach asks only for what it missed. */
  private readonly pos = new Map<string, { seq: number; epoch: string }>();
  /** Tiles whose session exists in the daemon: a re-attach must never start them again. */
  private readonly live = new Set<string>();
  private readonly replies = new Map<string, (msg: ServerMsg) => void>();
  private readonly screens = new Map<string, (replay: string | null) => void>();
  private seq = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** The socket this process serves the machine's control plane on (`control`): claimed again on
   *  each connection, which is kept up from then on. */
  private controlSock: string | null = null;
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
        // The answer to an attach this side gave up on: its tile was told it failed, so nothing may stream into it.
        if (msg.reqId.startsWith("a") && !this.pending.has(msg.reqId)) {
          if (msg.pid > 0 && !this.cbs.has(msg.id)) this.fire({ t: "detach", id: msg.id });
          break;
        }
        if (msg.asleep) {
          const cb = this.cbs.get(msg.id);
          this.forget(msg.id);
          // It was put to sleep while we were away.
          if (msg.reqId.startsWith("re")) cb?.onExit(0, undefined, true);
        }
        if (msg.error && (msg.reqId.startsWith("re") || this.live.has(msg.id))) {
          const cb = this.cbs.get(msg.id);
          this.forget(msg.id);
          // Gone while we were away (exited, or killed by another viewer).
          if (msg.reqId.startsWith("re")) { cb?.onExit(0, 1); break; }
        }
        if (msg.pid > 0) this.live.add(msg.id);
        if (msg.seq !== undefined && msg.epoch) this.pos.set(msg.id, { seq: msg.seq, epoch: msg.epoch });
        // The size first: the replay is drawn at it.
        if (msg.pid > 0 && msg.cols && msg.rows) this.cbs.get(msg.id)?.onSize?.(msg.cols, msg.rows);
        // A delta continues the stream exactly; a redraw of a tile that shows the old screen starts from a reset.
        const redraw = msg.reqId.startsWith("re") && !msg.delta;
        if (msg.replay) this.cbs.get(msg.id)?.onData(redraw ? REATTACH_RESET + msg.replay : msg.replay, true);
        const resolve = this.pending.get(msg.reqId);
        if (resolve) { this.pending.delete(msg.reqId); resolve({ pid: msg.pid, ...(msg.asleep ? { asleep: true as const } : {}), ...(msg.gone ? { gone: true as const } : {}), ...(msg.error ? { error: msg.error } : {}) }); }
        break;
      }
      case "data": {
        const p = this.pos.get(msg.id);
        if (p && msg.seq !== undefined) p.seq = msg.seq;
        this.cbs.get(msg.id)?.onData(msg.data);
        break;
      }
      case "size":
        this.cbs.get(msg.id)?.onSize?.(msg.cols, msg.rows);
        break;
      case "resync":
        this.pos.set(msg.id, { seq: msg.seq, epoch: msg.epoch });
        this.cbs.get(msg.id)?.onData(REATTACH_RESET + msg.replay, true);
        break;
      case "event":
        this.o.onEvent?.(msg.topic, msg.data);
        break;
      case "screen": {
        // Synchronously, in order with the data around it: the caller switches what it does
        // with this session's bytes exactly here.
        const cb = this.screens.get(msg.reqId);
        this.screens.delete(msg.reqId);
        cb?.(msg.replay);
        break;
      }
      case "pong":
      case "slept":
      case "sessions":
      case "control":
      case "viewport": {
        const reply = this.replies.get(msg.reqId);
        if (reply) { this.replies.delete(msg.reqId); reply(msg); }
        break;
      }
      case "exit": {
        const cb = this.cbs.get(msg.id);
        this.forget(msg.id);
        cb?.onExit(msg.code, msg.signal ?? undefined, msg.slept);
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
    if (this.controlSock) s.write(frame({ t: "control", reqId: `c${++this.seq}`, sock: this.controlSock }));
    s.on("data", makeLineDecoder(
      (line) => { try { this.handle(JSON.parse(line) as ServerMsg); } catch { /* not a protocol line */ } },
      () => { this.status("reconnecting", "the daemon sent a line that never ended"); s.destroy(); },
    ));
    s.on("close", () => {
      if (this.conn === s) this.conn = null;
      // Fail in-flight attaches now rather than after their timeout.
      for (const [reqId, resolve] of [...this.pending]) { this.pending.delete(reqId); resolve({ pid: -1 }); }
      for (const [reqId, cb] of [...this.screens]) { this.screens.delete(reqId); cb(null); }
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

  /** What an attach that may start a session carries: the environment it starts from. */
  private base(): { base?: Record<string, string> } {
    return this.o.env ? { base: this.o.env() } : {};
  }

  private async send(msg: ClientMsg): Promise<void> {
    (await this.ensure()).write(frame(msg));
  }

  private fire(msg: ClientMsg): void {
    this.send(msg).catch(() => { /* unreachable: re-attach retries on its own */ });
  }

  private scheduleReattach(): void {
    if (this.retry || this.closed || (this.cbs.size === 0 && !this.controlSock) || this.o.isPaused?.()) return;
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
        c.write(frame({ t: "attach", reqId: `re${++this.seq}`, id, spec, ...(since ? { since } : {}), ...(this.live.has(id) ? { noSpawn: true } : this.base()) }));
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

  /**
   * Serve the machine's control plane on `sock` from now on (`hive host`): the daemon passes each
   * connection to its own control-plane socket on to `sock`, and this endpoint claims it again on
   * every connection after, which it keeps up. Rejects with `ControlRefused` when the daemon
   * will not hand its socket over (one from an older release), and with an error when it does not
   * answer.
   */
  async control(sock: string, timeoutMs = 10_000): Promise<void> {
    const r = await this.request<Extract<ServerMsg, { t: "control" }>>({ t: "control", reqId: `c${++this.seq}`, sock }, timeoutMs);
    if (r.error) throw new ControlRefused(r.error);
    this.controlSock = sock;
  }

  /** Every session in the daemon, connecting if needed. */
  async sessions(timeoutMs = 15_000): Promise<SessionInfo[]> {
    const r = await this.request<Extract<ServerMsg, { t: "sessions" }>>({ t: "list", reqId: `l${++this.seq}`, detail: true }, timeoutMs);
    return r.detail ?? [];
  }

  async spawn(opts: SpawnOpts, cb: Callbacks): Promise<Attached> {
    this.cbs.set(opts.tileId, cb);
    const spec: AttachSpec = { cwd: opts.cwd, cmd: opts.cmd, args: opts.args ?? [], cols: opts.cols, rows: opts.rows, env: opts.env };
    this.specs.set(opts.tileId, spec);
    if (opts.noSpawn) this.live.add(opts.tileId);
    const reqId = `a${++this.seq}`;
    const result = new Promise<Attached & { error?: string; gone?: true }>((resolve) => { this.pending.set(reqId, resolve); });
    try {
      const agent = opts.noSpawn ? undefined : agentPackageFor(spec.cmd);
    await this.send({ t: "attach", reqId, id: opts.tileId, spec, ...(opts.noSpawn ? { noSpawn: true } : this.base()), ...(agent ? { agent } : {}), ...(opts.liveOnly ? { liveOnly: true } : {}), ...(opts.lines !== undefined ? { lines: opts.lines } : {}), ...(opts.wake ? { wake: true } : {}) });
    } catch (e) {
      // Unreachable now (e.g. offline): keep retrying so the tile attaches once it is back.
      const msg = e instanceof Error ? e.message : String(e);
      this.status("reconnecting", msg);
      if (!this.o.isFatal?.(msg)) this.scheduleReattach();
      if (this.pending.delete(reqId)) return { pid: -1 };
    }
    // Waited for as long as the daemon is alive: with many sessions starting at once, or a daemon
    // being replaced, an answer may take long. Only a daemon that stops answering is given up on.
    let r: (Attached & { error?: string; gone?: true }) | null = null;
    while (!r) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      r = await Promise.race([result, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), STILL_THERE_EVERY_MS); timer.unref?.(); })]);
      clearTimeout(timer);
      if (r || !this.pending.has(reqId)) break;
      if (!(await this.ping(STILL_THERE_WAIT_MS).then(() => true, () => false)) && this.pending.delete(reqId)) {
        // Let go of it, so an answer that comes after all does not stream into a tile that says it failed.
        this.detach(opts.tileId);
        return { pid: -1, error: "its daemon stopped answering" };
      }
    }
    r ??= await result;
    // Refused (nothing asleep there, or what it saved cannot be read): nothing to bring back later.
    if (opts.wake && r.error) {
      this.forget(opts.tileId);
      throw r.gone ? new NothingAsleep(r.error) : new Error(r.error);
    }
    return { pid: r.pid, ...(r.asleep ? { asleep: true as const } : {}), ...(r.error && !r.asleep && !r.gone ? { error: r.error } : {}) };
  }

  has(tileId: string): boolean { return this.specs.has(tileId); }
  write(tileId: string, data: string, paste?: boolean): void { this.fire({ t: "write", id: tileId, data, ...(paste ? { paste: true } : {}) }); }
  resize(tileId: string, cols: number, rows: number): void { this.fire({ t: "resize", id: tileId, cols, rows }); }
  repaint(tileId: string): void { this.fire({ t: "repaint", id: tileId }); }
  pause(tileId: string): void { this.fire({ t: "pause", id: tileId }); }
  resume(tileId: string): void { this.fire({ t: "resume", id: tileId }); }
  /** The session's screen now, with at most `lines` of its scrollback. `cb` runs synchronously in
   *  the message loop, so every data callback after it carries bytes the screen does not already
   *  show. */
  screen(tileId: string, cb: (replay: string | null) => void, lines?: number): void {
    const reqId = `sc${++this.seq}`;
    this.screens.set(reqId, cb);
    this.send({ t: "screen", reqId, id: tileId, lines }).catch(() => { this.screens.delete(reqId); cb(null); });
  }

  /** The session's screen as text, line by line, as the daemon reads it; null when it is not
   *  running. */
  async viewport(tileId: string, timeoutMs = 5_000): Promise<string | null> {
    const r = await this.request<Extract<ServerMsg, { t: "viewport" }>>({ t: "viewport", reqId: `v${++this.seq}`, id: tileId }, timeoutMs);
    return r.text;
  }

  /** End the session's process but keep it, its screen saved, for an attach to bring back. Rejects
   *  with the daemon's reason. */
  async sleep(tileId: string, timeoutMs = WAKE_TIMEOUT_MS): Promise<void> {
    const r = await this.request<Extract<ServerMsg, { t: "slept" }>>({ t: "sleep", reqId: `z${++this.seq}`, id: tileId }, timeoutMs);
    if (r.error) throw new Error(r.error);
  }

  /** What a sleeping session saved as its screen, with its newest 1000 lines when `lines` asks for no
   *  more (none: all of it); null when the daemon keeps it running or not at all. */
  saved(tileId: string, lines?: number): Promise<string | null> {
    return new Promise((resolve) => {
      const reqId = `sv${++this.seq}`;
      this.screens.set(reqId, resolve);
      setTimeout(() => { if (this.screens.delete(reqId)) resolve(null); }, SAVED_TIMEOUT_MS).unref?.();
      this.send({ t: "screen", reqId, id: tileId, saved: true, ...(lines !== undefined ? { lines } : {}) }).catch(() => { this.screens.delete(reqId); resolve(null); });
    });
  }

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
