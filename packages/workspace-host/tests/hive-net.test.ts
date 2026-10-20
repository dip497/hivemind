// The daemon client (hive-net.ts) with the real daemon (crates/hive-net, built with `cargo build`):
// two devices in one process. Someone asks to pair and the host's answer reaches them; a device
// the host admits connects, and text passes both ways, each frame on the stream it was sent on; one
// no longer admitted is cut off, and the host hears it go; a link closed saying why is read so on
// the other side, and a device that stops is heard going at once. And a daemon of another release,
// speaking another protocol, is refused, saying so. A frame of many megabytes costs main no more than
// the same bytes in small frames. A link to a device that stops taking what it is sent has no room
// once a little waits, and room again once it takes it; one that falls far behind is closed, saying
// so, though one big frame alone does not.
import { test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HiveNet, LINK_ROOM, MAX_FRAME, PROTOCOL, WAITING_AT_MOST, type Link } from "../src/hive-net.ts";

const BIN = path.join(import.meta.dir, "../../../crates/hive-net/target/debug/hive-net");
const built = fs.existsSync(BIN);
if (!built) console.warn(`hive-net.test.ts skipped: build the daemon first (cargo build in crates/hive-net)`);

const running: HiveNet[] = [];
afterEach(() => { for (const n of running.splice(0)) n.stop(); });

async function device(root: string, name: string, on: { incoming?: (l: Link) => void; pair?: (peer: string, hello: unknown) => Promise<unknown>; warn?: (m: string) => void } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "identity"), { recursive: true });
  fs.writeFileSync(path.join(dir, "identity", "device.key"), `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}\n`);
  const n = await HiveNet.start({
    bin: BIN,
    identity: path.join(dir, "identity"),
    socket: path.join(dir, "net.sock"),
    onIncoming: on.incoming ?? (() => {}),
    onPairRequest: on.pair ?? (async () => ({ ok: false })),
    onWarn: on.warn,
  });
  running.push(n);
  return n;
}
const next = <T>(register: (resolve: (v: T) => void) => void): Promise<T> => new Promise(register);

test.skipIf(!built)("pairing, then a connection the host admits, text both ways on named streams, and a cut-off the host hears", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hn-client-"));
  try {
    let incoming!: (l: Link) => void;
    const arrived = next<Link>((r) => { incoming = r; });
    const host = await device(root, "host", {
      incoming: (l) => incoming(l),
      pair: async (peer, hello) => ({ ok: true, you: peer, said: hello }),
    });
    const guest = await device(root, "guest");
    const where = { addrs: host.ready.addrs, relay: null };

    expect(await guest.pair(host.ready.id, where, { secret: "s" })).toEqual({ ok: true, you: guest.ready.id, said: { secret: "s" } });

    host.admit([guest.ready.id]);
    const link = await guest.dial(host.ready.id, where);
    expect(link.peer).toBe(host.ready.id);
    link.send("sync", "first on sync");
    link.send("api", "hello");
    const there = await arrived;
    expect(there.peer).toBe(guest.ready.id);
    // Each stream's frames reach that stream's listeners, and no other's.
    const onSync: string[] = [];
    there.on("sync", (t) => onSync.push(t));
    const heard = await next<string>((r) => there.on("api", r));
    expect(heard).toBe("hello");
    await Bun.sleep(50);
    expect(onSync).toEqual(["first on sync"]);
    const back = next<string>((r) => link.on("api", r));
    there.send("api", "hi");
    expect(await back).toBe("hi");

    host.admit([]);
    expect(await link.closed).toContain("removed");
    expect(await there.closed).toBeString();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(!built)("a link closed saying why is read so on the other side; a device that stops is heard going at once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hn-client-"));
  try {
    const arrivals: Link[] = [];
    const host = await device(root, "host", { incoming: (l) => arrivals.push(l) });
    const guest = await device(root, "guest");
    const where = { addrs: host.ready.addrs, relay: null };
    host.admit([guest.ready.id]);
    const dialled = async () => {
      const link = await guest.dial(host.ready.id, where);
      link.send("api", "hello");
      while (arrivals.length === 0) await Bun.sleep(20);
      return { link, there: arrivals.shift()! };
    };

    const first = await dialled();
    first.there.close("role changed");
    expect(await first.link.closed).toContain("role changed");

    const second = await dialled();
    const stopped = Date.now();
    host.stop();
    expect(await second.link.closed).toBeString();
    expect(Date.now() - stopped).toBeLessThan(2_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

/** The daemon started for the device whose socket is `socket`, as the system lists it. */
function daemonOf(socket: string): number {
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let cmd = "";
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
    if (cmd.includes("daemon") && cmd.includes(socket)) return Number(pid);
  }
  throw new Error(`no daemon for ${socket}`);
}

test.skipIf(!built || process.platform !== "linux")("a link to a device that stops taking has no room once a little waits, and room again once it takes it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hn-room-"));
  let stopped = 0;
  try {
    let incoming!: (l: Link) => void;
    const arrived = next<Link>((r) => { incoming = r; });
    const host = await device(root, "host", { incoming: (l) => incoming(l) });
    const guest = await device(root, "guest");
    host.admit([guest.ready.id]);
    const link = await guest.dial(host.ready.id, { addrs: host.ready.addrs, relay: null });
    let heard = 0;
    link.on("api", (t) => { heard += t.length; });
    link.send("api", "hello");
    const there = await arrived;
    await next<string>((r) => there.on("api", r));
    expect(there.hasRoom()).toBe(true);

    // The guest's network stops: nothing it is sent is acknowledged.
    stopped = daemonOf(path.join(root, "guest", "net.sock"));
    process.kill(stopped, "SIGSTOP");
    const chunk = "x".repeat(64 * 1024);
    const roomWithin = (ms: number) => Promise.race([new Promise<boolean>((r) => there.whenRoom(() => r(true))), Bun.sleep(ms).then(() => false)]);
    let sent = 0;
    for (;;) {
      while (there.hasRoom()) { there.send("api", chunk); sent += chunk.length; }
      if (!(await roomWithin(3_000))) break;
      if (sent > 64 * 1024 * 1024) throw new Error(`room for ${sent} bytes to a device that takes none`);
    }
    // What the network holds for it unacknowledged (1 MB) and the link's room: no more waits.
    expect(sent).toBeGreaterThanOrEqual(LINK_ROOM);
    expect(sent).toBeLessThan(4 * 1024 * 1024);
    expect(there.hasRoom()).toBe(false);

    process.kill(stopped, "SIGCONT");
    stopped = 0;
    expect(await roomWithin(20_000)).toBe(true);
    for (const until = Date.now() + 20_000; heard < sent && Date.now() < until;) await Bun.sleep(50);
    expect(heard).toBe(sent);
  } finally {
    if (stopped) process.kill(stopped, "SIGCONT");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

test.skipIf(!built)("a stream the dialling device opens beside another of its name is its own both ways; once it ends it, the other device hears it end and the other carries on", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hn-streams-"));
  try {
    const streams: Array<{ said: string[]; closed: Promise<string>; send(t: string): void }> = [];
    const host = await device(root, "host", {
      incoming: (there) => there.streams("api", (s) => { const said: string[] = []; s.on((t) => said.push(t)); streams.push({ said, closed: s.closed, send: (t) => s.send(t) }); }),
    });
    const guest = await device(root, "guest");
    host.admit([guest.ready.id]);
    const link = await guest.dial(host.ready.id, { addrs: host.ready.addrs, relay: null });
    // Two windows, each with an `api` stream of its own.
    const [a, b] = [link.open("api"), link.open("api")];
    a.send("from a");
    b.send("from b");
    while (streams.filter((s) => s.said.length > 0).length < 2) await Bun.sleep(20);
    const [toA, toB] = [streams.find((s) => s.said[0] === "from a")!, streams.find((s) => s.said[0] === "from b")!];
    const [atA, atB] = [next<string>((r) => a.on(r)), next<string>((r) => b.on(r))];
    toA.send("to a");
    toB.send("to b");
    expect([await atA, await atB]).toEqual(["to a", "to b"]);

    a.end();
    expect(await a.closed).toBe("ended");
    expect(await toA.closed).toBe("ended");
    b.send("b again");
    while (toB.said.length < 2) await Bun.sleep(20);
    expect(toB.said).toEqual(["from b", "b again"]);
    expect(toA.said).toEqual(["from a"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(!built || process.platform !== "linux")("a link to a device that stops taking is not closed for one big frame, and is closed as too slow, saying so, once far more waits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hn-ceiling-"));
  let stopped = 0;
  try {
    let incoming!: (l: Link) => void;
    const arrived = next<Link>((r) => { incoming = r; });
    const warned: string[] = [];
    const host = await device(root, "host", { incoming: (l) => incoming(l), warn: (m) => warned.push(m) });
    const guest = await device(root, "guest");
    host.admit([guest.ready.id]);
    const link = await guest.dial(host.ready.id, { addrs: host.ready.addrs, relay: null });
    link.send("api", "hello");
    const there = await arrived;
    await next<string>((r) => there.on("api", r));
    let closed: string | null = null;
    void there.closed.then((why) => { closed = why; });

    stopped = daemonOf(path.join(root, "guest", "net.sock"));
    process.kill(stopped, "SIGSTOP");
    // A welcome of 32 MB to a device that takes nothing for now: it waits, and the link stays.
    there.send("api", "w".repeat(32 * 1024 * 1024));
    await Bun.sleep(2_000);
    expect(closed).toBeNull();

    // Then more than the link may hold beyond it, in small frames: closed, saying why.
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i * chunk.length <= WAITING_AT_MOST + 2 * chunk.length; i++) there.send("api", chunk);
    for (const until = Date.now() + 10_000; closed === null && Date.now() < until;) await Bun.sleep(50);
    expect(closed).toMatch(/^too slow \(\d+ MB waiting\)$/);
    expect(warned).toEqual([`the link to ${guest.ready.id.slice(0, 8)}… is closed: ${closed}`]);
  } finally {
    if (stopped) process.kill(stopped, "SIGCONT");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

/** A fake daemon that answers a dial, says the network took all but 256 KB of any frame over 8 MB
 *  it is sent, and writes each message main tells it to `heard`, one a line. */
function takingDaemon(root: string): string {
  fs.writeFileSync(path.join(root, "taking-daemon.mjs"), [
    "import net from 'node:net';",
    "import fs from 'node:fs';",
    `const heard = ${JSON.stringify(path.join(root, "heard"))};`,
    "const framed = (body) => { const head = Buffer.alloc(4); head.writeUInt32BE(body.length); return Buffer.concat([head, body]); };",
    "const frame = (m) => framed(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(m))]));",
    "const s = net.connect(process.argv[process.argv.indexOf('--socket') + 1], () => {",
    `  s.write(frame({ t: 'ready', v: ${PROTOCOL}, id: 'a'.repeat(64), addrs: [], relay: null, lookup: null }));`,
    "});",
    "let parts = [], have = 0;",
    "s.on('data', (d) => {",
    "  parts.push(d); have += d.length;",
    "  let buf = Buffer.concat(parts); parts = [buf];",
    "  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {",
    "    const body = buf.subarray(4, 4 + buf.readUInt32BE(0));",
    "    buf = buf.subarray(4 + body.length); parts = [buf];",
    "    if (body[0] === 0) {",
    "      const m = JSON.parse(body.toString('utf8', 1));",
    "      fs.appendFileSync(heard, JSON.stringify(m) + '\\n');",
    "      if (m.t === 'dial') s.write(frame({ t: 'dialed', req: m.req, conn: 2 }));",
    "    } else if (body.length - 17 > 8 * 1024 * 1024) {",
    "      s.write(frame({ t: 'took', conn: Number(body.readBigUInt64BE(1)), stream: Number(body.readBigUInt64BE(9)), n: body.length - 17 - 256 * 1024 }));",
    "    }",
    "  }",
    "});",
    "s.on('close', () => process.exit(0));",
  ].join("\n"));
  const bin = path.join(root, "hive-net");
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "taking-daemon.mjs")}" "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(root, "identity"));
  return bin;
}

test("once the network took most of one big frame, a link holds no more than the ceiling beyond what still waits of it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hn-took-"));
  try {
    const warned: string[] = [];
    const net = await HiveNet.start({ bin: takingDaemon(root), identity: path.join(root, "identity"), socket: path.join(root, "net.sock"), onIncoming: () => {}, onPairRequest: async () => ({}), onWarn: (m) => warned.push(m) });
    running.push(net);
    const link = await net.dial("b".repeat(64), { addrs: [], relay: null });
    link.send("api", "w".repeat(32 * 1024 * 1024));
    // All but 256 KB of it is taken: the link has room again.
    await new Promise<void>((resolve) => link.whenRoom(resolve));
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i * chunk.length <= WAITING_AT_MOST + 2 * chunk.length; i++) link.send("api", chunk);
    expect(warned).toEqual([`the link to bbbbbbbb… is closed: too slow (17 MB waiting)`]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("a frame over the daemon's limit fails as it is sent, and its stream is not opened", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hn-over-"));
  try {
    const net = await HiveNet.start({ bin: takingDaemon(root), identity: path.join(root, "identity"), socket: path.join(root, "net.sock"), onIncoming: () => {}, onPairRequest: async () => ({}) });
    running.push(net);
    const link = await net.dial("b".repeat(64), { addrs: [], relay: null });
    expect(() => link.send("files", "f".repeat(MAX_FRAME))).toThrow(`a frame of ${MAX_FRAME} bytes on files is over hive-net's limit`);
    link.send("api", "after it");
    for (const until = Date.now() + 10_000; !fs.readFileSync(path.join(root, "heard"), "utf8").includes('"api"') && Date.now() < until;) await Bun.sleep(20);
    const opened = fs.readFileSync(path.join(root, "heard"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.t === "open");
    expect(opened.map((m) => m.name)).toEqual(["api"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(!built)("a device announces what it wants found, and the devices nearby find it with that, then without it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hn-nearby-"));
  try {
    const offering = await device(root, "offering");
    const entering = await device(root, "entering");
    offering.advertise("hive-pair=0a1b2c3d");
    const seen = async (want: string | null) => {
      for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
        const found = (await entering.nearby()).find((d) => d.id === offering.ready.id);
        if (found && found.data === want) return found;
      }
      throw new Error(`the offering device was not seen announcing ${String(want)}`);
    };
    expect(await seen("hive-pair=0a1b2c3d")).toEqual({ id: offering.ready.id, data: "hive-pair=0a1b2c3d" });
    offering.advertise(null);
    expect(await seen(null)).toEqual({ id: offering.ready.id, data: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test.each([
  ["no protocol", "", 1],
  ["protocol 3, untagged as protocol 2 sent it", ", v: 3", 2],
])("a daemon of an earlier release, whose ready says %s, is refused, saying which each speaks", async (_, v, speaks) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hn-old-"));
  try {
    // It connects where it is told to, and says it is ready as one before protocol 3 did: untagged.
    fs.writeFileSync(path.join(root, "old-daemon.mjs"), [
      "import net from 'node:net';",
      "const s = net.connect(process.argv[process.argv.indexOf('--socket') + 1], () => {",
      `  const body = Buffer.from(JSON.stringify({ t: 'ready'${v}, id: 'a'.repeat(64), addrs: [], relay: null, lookup: null }));`,
      "  const head = Buffer.alloc(4); head.writeUInt32BE(body.length);",
      "  s.write(Buffer.concat([head, body]));",
      "});",
      "s.on('close', () => process.exit(0));",
    ].join("\n"));
    const bin = path.join(root, "hive-net");
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "old-daemon.mjs")}" "$@"\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(root, "identity"));
    const started = HiveNet.start({ bin, identity: path.join(root, "identity"), socket: path.join(root, "net.sock"), onIncoming: () => {}, onPairRequest: async () => ({}) });
    await expect(started).rejects.toThrow(`hive-net speaks the daemon's protocol ${speaks}, and this app ${PROTOCOL}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a daemon that ends before it is ready is refused with what it said, and leaves nothing listening", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hn-ended-"));
  try {
    // It connects where it is told to, says why it cannot go on, and ends, as one that cannot open
    // its network does.
    fs.writeFileSync(path.join(root, "ending-daemon.mjs"), [
      "import net from 'node:net';",
      "const s = net.connect(process.argv[process.argv.indexOf('--socket') + 1], () => {",
      "  process.stderr.write('hive-net: no network to look on\\n');",
      "  s.end(() => process.exit(1));",
      "});",
    ].join("\n"));
    const bin = path.join(root, "hive-net");
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "ending-daemon.mjs")}" "$@"\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(root, "identity"));
    const socket = path.join(root, "net.sock");
    const started = HiveNet.start({ bin, identity: path.join(root, "identity"), socket, onIncoming: () => {}, onPairRequest: async () => ({}) });
    await expect(started).rejects.toThrow("hive-net: no network to look on");
    const reached = await new Promise<boolean>((resolve) => {
      const c = new net.Socket();
      c.once("error", () => resolve(false));
      c.connect(socket, () => { c.destroy(); resolve(true); });
    });
    expect(reached).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a frame of many megabytes from the daemon is read as fast as the same bytes in small frames", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hn-big-"));
  try {
    // A daemon that says a device connected and opened a stream, then sends 32 MB on it as 32
    // frames of 1 MB, and once main has them, as one frame of 32 MB: an answer to a file read or a
    // welcome comes so.
    fs.writeFileSync(path.join(root, "big-daemon.mjs"), [
      "import net from 'node:net';",
      "const framed = (body) => { const head = Buffer.alloc(4); head.writeUInt32BE(body.length); return Buffer.concat([head, body]); };",
      "const frame = (m) => framed(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(m))]));",
      "const ids = Buffer.alloc(17); ids[0] = 1; ids.writeBigUInt64BE(1n, 1); ids.writeBigUInt64BE(7n, 9);",
      "const recv = (mb) => framed(Buffer.concat([ids, Buffer.from('x'.repeat(mb * 1024 * 1024))]));",
      "const small = recv(1), big = recv(32);",
      "const s = net.connect(process.argv[process.argv.indexOf('--socket') + 1], () => {",
      `  s.write(frame({ t: 'ready', v: ${PROTOCOL}, id: 'a'.repeat(64), addrs: [], relay: null, lookup: null }));`,
      "  s.write(frame({ t: 'incoming', conn: 1, peer: 'b'.repeat(64) }));",
      "  s.write(frame({ t: 'opened', conn: 1, stream: 7, name: 'api' }));",
      "  for (let i = 0; i < 32; i++) s.write(small);",
      "});",
      "s.on('data', () => s.write(big));",
      "s.on('close', () => process.exit(0));",
    ].join("\n"));
    const bin = path.join(root, "hive-net");
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "big-daemon.mjs")}" "$@"\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(root, "identity"));
    // This process's CPU time, so that the fake daemon's own work and the machine's load do not count.
    const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
    const arrived: Array<{ length: number; at: number }> = [];
    const net = await HiveNet.start({
      bin, identity: path.join(root, "identity"), socket: path.join(root, "net.sock"),
      onIncoming: (link) => link.streams("api", (s) => s.on((data) => arrived.push({ length: data.length, at: cpu() }))),
      onPairRequest: async () => ({}),
    });
    running.push(net);
    const start = cpu();
    // Main's hello tells it to send the big one: it goes once the small ones are read.
    while (arrived.length < 33) await Bun.sleep(20);
    const smalls = arrived[31]!.at - start;
    const big = arrived[32]!.at - arrived[31]!.at;
    expect(arrived.map((a) => a.length)).toEqual([...Array(32).fill(1024 * 1024), 32 * 1024 * 1024]);
    // Joining what came so far on each chunk made the one frame cost four times the small ones.
    expect(big).toBeLessThan(2 * smalls);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
