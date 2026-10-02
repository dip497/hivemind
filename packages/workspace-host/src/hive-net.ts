/**
 * hive-net's daemon, for this process (R11, M1): started as a child with a local socket this
 * process listens on (0600; a named pipe on Windows), and spoken to in its messages
 * (`crates/hive-net/src/daemon.rs`): JSON in frames of a u32 big-endian length and the bytes, in
 * the daemon's protocol `PROTOCOL`, which each side says it speaks before anything else. The
 * network is the daemon's: it finds devices, holds connections and admits only the devices given
 * to it. What the frames on a connection mean is ours.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

/** Where a device can be reached: its direct addresses, and a relay it uses. */
export interface Where {
  addrs: string[];
  relay: string | null;
}

/** This device on the network, as the daemon found it. */
export interface Ready extends Where {
  id: string;
  /** The network's lookup server, when it has one: where devices say which workspaces they host
   *  (M3, spec/host-record.md). */
  lookup: string | null;
}

/** Which device hosts a workspace, and how many moves brought it there (spec/host-record.md). */
export interface HostRecord {
  host: string;
  seq: number;
}

/** A host record as a lookup server keeps it: what it says, and the record itself, signed by the
 *  workspace's key, to hand on to whoever asks (spec/hosting.md). */
export interface FoundHost extends HostRecord {
  record: string;
}

/** The daemon's protocol: what this process speaks to it (`PROTOCOL` in daemon.rs). 2: a stream is
 *  known by its id, and a connection carries any number of streams of one name. */
export const PROTOCOL = 2;

/** One stream of a connection: frames of text, both ways, from when it opens until it ends. */
export interface Stream {
  /** Send `data` on it, after everything sent on it before. */
  send(data: string): void;
  /** Hear each frame that arrives on it. */
  on(listener: (data: string) => void): () => void;
  /** Resolves, with why, when it ends: the other device ended it, or the connection went. */
  readonly closed: Promise<string>;
}

/** One connection to another device, on `hive/ws/1`: frames of text on named streams. The device
 *  that dialled opens them, as many of a name as it likes (a phone opens an `api` stream for each
 *  terminal it watches, conversation it follows and call it makes); the other side answers on
 *  them. */
export interface Link {
  /** The other device's id, as its key proved it. */
  readonly peer: string;
  /** Send `data` on `stream`, after everything sent on it before: on the stream of that name this
   *  device opened, opening it the first time (and again once it ended), when it dialled; else on
   *  the newest of that name the other device opened, if it opened one. */
  send(stream: string, data: string): void;
  /** Hear each frame that arrives on every stream named `stream`. */
  on(stream: string, listener: (data: string) => void): () => void;
  /** Each stream named `stream` the other device opens from now on, as it opens it: a stream of
   *  its own, its frames its own, and answered on alone. */
  streams(stream: string, listener: (opened: Stream) => void): () => void;
  /** Close it, saying why to the other side ("removed", "left", …). */
  close(reason?: string): void;
  /** Resolves, with why, when the connection is gone. */
  readonly closed: Promise<string>;
}

/** A device on this network, as mDNS found it. */
export interface Nearby {
  id: string;
  /** What it announces; null for nothing. */
  data: string | null;
}

export interface HiveNetOptions {
  /** The daemon's executable. */
  bin: string;
  /** The directory holding this device's key (`device.key`). */
  identity: string;
  /** Where to listen for the daemon: a path (or a named pipe's name on Windows). */
  socket: string;
  /** The network profile to use (what hive-net's `--profile` takes); none: the local network. */
  profile?: string;
  /** Someone connected; they are a device the daemon was told to admit. */
  onIncoming(link: Link): void;
  /** Someone asks to pair: what to answer them. */
  onPairRequest(peer: string, hello: unknown): Promise<unknown>;
  /** The daemon stopped, and why. */
  onExit?(why: string): void;
}

type Message = Record<string, unknown> & { t: string };

/** A stream of a connection the daemon holds, by its id there. */
class DaemonStream implements Stream {
  readonly listeners = new Set<(data: string) => void>();
  readonly closed: Promise<string>;
  end!: (why: string) => void;
  constructor(readonly id: number, readonly name: string, private readonly link: DaemonLink) {
    this.closed = new Promise((resolve) => { this.end = resolve; });
  }
  send(data: string): void {
    this.link.write(this, data);
  }
  on(listener: (data: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

class DaemonLink implements Link {
  /** Its streams open now, by id: given here to those this device opens, when it dialled; by the
   *  daemon to those the other device opens, when it did. */
  private readonly open = new Map<number, DaemonStream>();
  /** The newest stream open of each name: where `send` goes. */
  private readonly newest = new Map<string, DaemonStream>();
  private readonly listeners = new Map<string, Set<(data: string) => void>>();
  private readonly accepting = new Map<string, Set<(opened: Stream) => void>>();
  private nextStream = 1;
  readonly closed: Promise<string>;
  private end!: (why: string) => void;
  constructor(readonly conn: number, readonly peer: string, private readonly dialled: boolean, private readonly tell: (m: Message) => void) {
    this.closed = new Promise((resolve) => { this.end = resolve; });
  }
  send(stream: string, data: string): void {
    let s = this.newest.get(stream);
    if (!s) {
      // The device that dialled opens the streams; the other side answers on those it opened.
      if (!this.dialled) return;
      s = this.add(this.nextStream++, stream);
      this.tell({ t: "open", conn: this.conn, stream: s.id, name: stream });
    }
    this.write(s, data);
  }
  /** `data` on the stream `s`, while it is open: one that ended takes nothing more. */
  write(s: DaemonStream, data: string): void {
    if (this.open.get(s.id) === s) this.tell({ t: "send", conn: this.conn, stream: s.id, data });
  }
  on(stream: string, listener: (data: string) => void): () => void {
    let set = this.listeners.get(stream);
    if (!set) this.listeners.set(stream, (set = new Set()));
    set.add(listener);
    return () => { set!.delete(listener); };
  }
  streams(stream: string, listener: (opened: Stream) => void): () => void {
    let set = this.accepting.get(stream);
    if (!set) this.accepting.set(stream, (set = new Set()));
    set.add(listener);
    return () => { set!.delete(listener); };
  }
  close(reason?: string): void {
    this.tell({ t: "close", conn: this.conn, reason });
  }
  /** The other device opened the stream `id`, named `name`. */
  opened(id: number, name: string): void {
    const s = this.add(id, name);
    for (const l of this.accepting.get(name) ?? []) l(s);
  }
  receive(id: number, data: string): void {
    const s = this.open.get(id);
    if (!s) return;
    for (const l of s.listeners) l(data);
    for (const l of this.listeners.get(s.name) ?? []) l(data);
  }
  /** Nothing more goes either way on the stream `id`. */
  ended(id: number): void {
    const s = this.open.get(id);
    if (!s) return;
    this.open.delete(id);
    if (this.newest.get(s.name) === s) this.newest.delete(s.name);
    s.end("ended");
  }
  gone(why: string): void {
    for (const s of this.open.values()) s.end(why);
    this.open.clear();
    this.newest.clear();
    this.end(why);
  }
  private add(id: number, name: string): DaemonStream {
    const s = new DaemonStream(id, name, this);
    this.open.set(id, s);
    this.newest.set(name, s);
    return s;
  }
}

export class HiveNet {
  private readonly links = new Map<number, DaemonLink>();
  private readonly waiting = new Map<number, { resolve(m: Message): void; reject(e: Error): void }>();
  private nextReq = 1;
  private stopped = false;

  private constructor(
    private readonly opts: HiveNetOptions,
    private readonly server: net.Server,
    private readonly socket: net.Socket,
    private readonly child: ChildProcess,
    /** This device on the network. */
    readonly ready: Ready,
  ) {}

  /** Start the daemon and wait until it is on the network. */
  static async start(opts: HiveNetOptions): Promise<HiveNet> {
    if (process.platform !== "win32") fs.rmSync(opts.socket, { force: true });
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.socket, () => resolve());
    });
    if (process.platform !== "win32") fs.chmodSync(opts.socket, 0o600);
    const args = ["daemon", "--socket", opts.socket, "--identity", opts.identity, ...(opts.profile ? ["--profile", opts.profile] : [])];
    const child = spawn(opts.bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    const exited = new Promise<never>((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`hive-net exited (${code}): ${stderr.trim()}`)));
    });
    const socket = await Promise.race([new Promise<net.Socket>((resolve) => server.once("connection", resolve)), exited]);
    const frames = readFrames(socket);
    const first = await Promise.race([frames.next(), exited]);
    exited.catch(() => {});
    if (first.done || (first.value as Message).t !== "ready") throw new Error("hive-net did not say it was ready");
    const r = first.value as unknown as Ready & { v?: unknown };
    // One of another release speaks another protocol: said so, and stopped, rather than half heard.
    if (r.v !== PROTOCOL) {
      child.kill();
      socket.destroy();
      server.close();
      throw new Error(`hive-net speaks the daemon's protocol ${typeof r.v === "number" ? r.v : 1}, and this app ${PROTOCOL}: install the app and hive-net from one release`);
    }
    child.removeAllListeners("exit");
    child.removeAllListeners("error");
    const hn = new HiveNet(opts, server, socket, child, { id: r.id, addrs: r.addrs, relay: r.relay ?? null, lookup: r.lookup ?? null });
    hn.tell({ t: "hello", v: PROTOCOL });
    child.once("exit", (code) => hn.gone(`hive-net exited (${code}): ${stderr.trim()}`));
    child.on("error", (e) => hn.gone(`hive-net: ${e.message}`));
    void hn.read(frames);
    return hn;
  }

  /** Admit exactly these devices from now on; any other loses its connections at once. */
  admit(devices: string[]): void {
    this.tell({ t: "admit", devices });
  }

  /** Connect to the device `peer`, at `where` if given (on the local network it is found by its id). */
  async dial(peer: string, where: Where = { addrs: [], relay: null }): Promise<Link> {
    const answer = await this.ask({ t: "dial", peer, addrs: where.addrs, relay: where.relay });
    if (answer.t === "failed") throw new Error(String(answer.error));
    return this.linked(answer.conn as number, peer, true);
  }

  /** Ask the device `peer` to pair, with `hello`; what it answers. */
  async pair(peer: string, where: Where, hello: unknown): Promise<unknown> {
    const answer = await this.ask({ t: "pair", peer, addrs: where.addrs, relay: where.relay, hello });
    if (answer.t === "failed") throw new Error(String(answer.error));
    return answer.reply;
  }

  /** Announce `data` to the devices on this network (in this device's mDNS record), or nothing. */
  advertise(data: string | null): void {
    this.tell({ t: "advertise", data });
  }

  /** The devices on this network mDNS has found, with what each announces. */
  async nearby(): Promise<Nearby[]> {
    const answer = await this.ask({ t: "nearby" });
    return Array.isArray(answer.devices) ? (answer.devices as Nearby[]) : [];
  }

  /** Say at the network's lookup server that this device hosts the person's workspace `workspace`,
   *  the `seq`th to (spec/host-record.md): the daemon signs it with the workspace's key. */
  async publishHost(workspace: string, seq: number): Promise<void> {
    const answer = await this.ask({ t: "host-record", workspace, seq });
    if (answer.t === "failed") throw new Error(String(answer.error));
  }

  /** Which device hosts the workspace whose public key is `key`, as the lookup server `lookup` (or
   *  this network's) has it, its signature checked; null when it names none. */
  async resolveHost(key: string, lookup?: string | null): Promise<FoundHost | null> {
    const answer = await this.ask({ t: "resolve-host", key, ...(lookup ? { lookup } : {}) });
    if (answer.t === "failed") throw new Error(String(answer.error));
    return typeof answer.host === "string" && typeof answer.seq === "number" && typeof answer.packet === "string"
      ? { host: answer.host, seq: answer.seq, record: answer.packet }
      : null;
  }

  /** A record saying that `host` hosts the person's workspace `workspace`, the `seq`th to, signed by
   *  the workspace's key here: what a move hands to the people in it (spec/hosting.md). */
  async signHost(workspace: string, seq: number, host: string): Promise<string> {
    const answer = await this.ask({ t: "sign-host", workspace, seq, host });
    if (answer.t === "failed") throw new Error(String(answer.error));
    return String(answer.packet);
  }

  /** What a record handed over says, its signature checked against the workspace's key `key`. */
  async verifyHost(key: string, packet: string): Promise<HostRecord> {
    const answer = await this.ask({ t: "verify-host", key, packet });
    if (answer.t === "failed" || typeof answer.host !== "string" || typeof answer.seq !== "number") {
      throw new Error(answer.t === "failed" ? String(answer.error) : "not a host record");
    }
    return { host: answer.host, seq: answer.seq };
  }

  /** Stop the daemon: it is told by its socket closing, and closes its connections so the devices
   *  at their other ends hear at once; one still running after a few seconds is killed. */
  stop(): void {
    this.stopped = true;
    this.socket.destroy();
    this.server.close();
    const kill = setTimeout(() => this.child.kill(), 3_000);
    kill.unref();
    this.child.once("exit", () => clearTimeout(kill));
  }

  private ask(message: Message): Promise<Message> {
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      this.waiting.set(req, { resolve, reject });
      this.tell({ ...message, req });
    });
  }

  private corked = false;

  /** Messages told in one turn go to the daemon in one write: a moment's frames to every peer are
   *  one system call, not one each. */
  private tell(message: Message): void {
    if (this.stopped) return;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    if (!this.corked) {
      this.corked = true;
      this.socket.cork();
      process.nextTick(() => {
        this.corked = false;
        this.socket.uncork();
      });
    }
    this.socket.write(Buffer.concat([head, body]));
  }

  /** The connection `conn` to `peer`, which this device `dialled`, or accepted. */
  private linked(conn: number, peer: string, dialled: boolean): DaemonLink {
    const link = new DaemonLink(conn, peer, dialled, (m) => this.tell(m));
    this.links.set(conn, link);
    return link;
  }

  private async read(frames: AsyncGenerator<Message>): Promise<void> {
    try {
      await this.take(frames);
    } catch {
      // The socket was destroyed while it was read (`stop`), or failed: gone either way.
    }
    this.gone("hive-net's socket closed");
  }

  private async take(frames: AsyncGenerator<Message>): Promise<void> {
    for await (const m of frames) {
      switch (m.t) {
        case "incoming":
          this.opts.onIncoming(this.linked(m.conn as number, m.peer as string, false));
          break;
        case "opened":
          this.links.get(m.conn as number)?.opened(m.stream as number, m.name as string);
          break;
        case "recv":
          this.links.get(m.conn as number)?.receive(m.stream as number, m.data as string);
          break;
        case "ended":
          this.links.get(m.conn as number)?.ended(m.stream as number);
          break;
        case "closed": {
          const link = this.links.get(m.conn as number);
          this.links.delete(m.conn as number);
          link?.gone(String(m.reason));
          break;
        }
        case "pair-request": {
          const req = m.req;
          this.opts.onPairRequest(m.peer as string, m.hello).then(
            (reply) => this.tell({ t: "pair-reply", req, reply }),
            (e: unknown) => this.tell({ t: "pair-reply", req, reply: { ok: false, error: e instanceof Error ? e.message : String(e) } }),
          );
          break;
        }
        default: {
          const waiter = this.waiting.get(m.req as number);
          if (waiter) {
            this.waiting.delete(m.req as number);
            waiter.resolve(m);
          }
        }
      }
    }
  }

  private gone(why: string): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const w of this.waiting.values()) w.reject(new Error(why));
    this.waiting.clear();
    for (const link of this.links.values()) link.gone(why);
    this.links.clear();
    this.server.close();
    this.opts.onExit?.(why);
  }
}

/** The daemon's messages, one per frame. */
async function* readFrames(socket: net.Socket): AsyncGenerator<Message> {
  let buf = Buffer.alloc(0);
  for await (const chunk of socket as AsyncIterable<Buffer>) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      yield JSON.parse(buf.subarray(4, 4 + len).toString("utf8")) as Message;
      buf = buf.subarray(4 + len);
    }
  }
}
