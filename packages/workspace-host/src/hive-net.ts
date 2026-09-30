/**
 * hive-net's daemon, for this process (R11, M1): started as a child with a local socket this
 * process listens on (0600; a named pipe on Windows), and spoken to in its messages
 * (`crates/hive-net/src/daemon.rs`): JSON in frames of a u32 big-endian length and the bytes.
 * The network is the daemon's: it finds devices, holds connections and admits only the devices
 * given to it. What the frames on a connection mean is ours.
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
}

/** One connection to another device, on `hive/ws/1`: frames of text on named streams. */
export interface Link {
  /** The other device's id, as its key proved it. */
  readonly peer: string;
  /** Send `data` on `stream`, after everything sent on it before. The device that dialled opens a
   *  stream by sending on it; the other side can only answer on streams opened to it. */
  send(stream: string, data: string): void;
  /** Hear each frame that arrives on `stream`. */
  on(stream: string, listener: (data: string) => void): () => void;
  /** Close it, saying why to the other side ("removed", "left", …). */
  close(reason?: string): void;
  /** Resolves, with why, when the connection is gone. */
  readonly closed: Promise<string>;
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

class DaemonLink implements Link {
  private readonly listeners = new Map<string, Set<(data: string) => void>>();
  readonly closed: Promise<string>;
  private end!: (why: string) => void;
  constructor(readonly conn: number, readonly peer: string, private readonly tell: (m: Message) => void) {
    this.closed = new Promise((resolve) => { this.end = resolve; });
  }
  send(stream: string, data: string): void {
    this.tell({ t: "send", conn: this.conn, stream, data });
  }
  on(stream: string, listener: (data: string) => void): () => void {
    let set = this.listeners.get(stream);
    if (!set) this.listeners.set(stream, (set = new Set()));
    set.add(listener);
    return () => { set!.delete(listener); };
  }
  close(reason?: string): void {
    this.tell({ t: "close", conn: this.conn, reason });
  }
  receive(stream: string, data: string): void {
    for (const l of this.listeners.get(stream) ?? []) l(data);
  }
  gone(why: string): void {
    this.end(why);
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
    if (first.done || (first.value as Message).t !== "ready") throw new Error("hive-net did not say it was ready");
    const r = first.value as unknown as Ready;
    exited.catch(() => {});
    child.removeAllListeners("exit");
    child.removeAllListeners("error");
    const hn = new HiveNet(opts, server, socket, child, { id: r.id, addrs: r.addrs, relay: r.relay ?? null });
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
    return this.linkFor(answer.conn as number, peer);
  }

  /** Ask the device `peer` to pair, with `hello`; what it answers. */
  async pair(peer: string, where: Where, hello: unknown): Promise<unknown> {
    const answer = await this.ask({ t: "pair", peer, addrs: where.addrs, relay: where.relay, hello });
    if (answer.t === "failed") throw new Error(String(answer.error));
    return answer.reply;
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

  private tell(message: Message): void {
    if (this.stopped) return;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([head, body]));
  }

  private linkFor(conn: number, peer: string): DaemonLink {
    let link = this.links.get(conn);
    if (!link) this.links.set(conn, (link = new DaemonLink(conn, peer, (m) => this.tell(m))));
    return link;
  }

  private async read(frames: AsyncGenerator<Message>): Promise<void> {
    for await (const m of frames) {
      switch (m.t) {
        case "incoming":
          this.opts.onIncoming(this.linkFor(m.conn as number, m.peer as string));
          break;
        case "recv":
          this.links.get(m.conn as number)?.receive(m.stream as string, m.data as string);
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
    this.gone("hive-net's socket closed");
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
