// The daemon client (hive-net.ts) with the real daemon (crates/hive-net, built with `cargo build`):
// two devices in one process. Someone asks to pair and the host's answer reaches them; a device
// the host admits connects, and text passes both ways, each frame on the stream it was sent on; one
// no longer admitted is
// cut off, and the host hears it go.
import { test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveNet, type Link } from "../src/hive-net.ts";

const BIN = path.join(import.meta.dir, "../../../crates/hive-net/target/debug/hive-net");
const built = fs.existsSync(BIN);
if (!built) console.warn(`hive-net.test.ts skipped: build the daemon first (cargo build in crates/hive-net)`);

const running: HiveNet[] = [];
afterEach(() => { for (const n of running.splice(0)) n.stop(); });

async function device(root: string, name: string, on: { incoming?: (l: Link) => void; pair?: (peer: string, hello: unknown) => Promise<unknown> } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "identity"), { recursive: true });
  fs.writeFileSync(path.join(dir, "identity", "device.key"), `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}\n`);
  const n = await HiveNet.start({
    bin: BIN,
    identity: path.join(dir, "identity"),
    socket: path.join(dir, "net.sock"),
    onIncoming: on.incoming ?? (() => {}),
    onPairRequest: on.pair ?? (async () => ({ ok: false })),
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
