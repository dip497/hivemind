// A phone's key echo without the e2e suite, in two legs, each timed apart:
//   host:  a phone device types into a shell tile as the phone page does (Backspace, then a
//          letter; each frame acked), through the link, both hive-net daemons, host main
//          (PeerLinks, servePeer, WorkspaceServer, Terminals), the PTY daemon and bash, and back.
//   page:  the page's own Device (crates/hive-web/www/echo.html) in headless Chromium, through a
//          relay, to the host's daemon and main, which send each frame back.
// What phone-terminal.spec.ts measures adds the page's two frames (about 22 ms at 60 Hz).
//
//   cd apps/desktop && bun scripts/phone-echo.ts [keys]
//
// Needs out/ (electron-vite build: the PTY daemon), crates/hive-net's debug build, and for the page
// leg crates/hive-web/build.sh. HIVE_NET_BIN names another hive-net, PHONE_PAGE a page built elsewhere.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { HiveNet, type Link } from "../../../packages/workspace-host/src/hive-net.ts";
import { machineKeys } from "../../../packages/workspace-host/src/keyring.ts";
import { certifyDevice, idOf, type DeviceCertificate } from "../../../packages/workspace-host/src/identity.ts";
import { AccessLists } from "../../../packages/workspace-host/src/access.ts";
import { AuditLog } from "../../../packages/workspace-host/src/audit-log.ts";
import { Intents } from "../../../packages/workspace-host/src/intents.ts";
import { WorkspaceStore } from "../../../packages/workspace-host/src/store.ts";
import { WorkspaceServer, type Connection } from "../../../packages/workspace-api/src/server.ts";
import { DaemonEndpoint, REATTACH_RESET } from "../../../packages/agent-host/src/daemon-endpoint.ts";
import { daemonSessions } from "../../../packages/host/src/daemon-sessions.ts";
import { Terminals } from "../../../packages/host/src/terminals.ts";
import { workspaceDomains } from "../../../packages/host/src/domains.ts";
import { PeerLinks } from "../../../packages/host/src/peer-links.ts";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const BIN = process.env.HIVE_NET_BIN ?? path.join(repoRoot, "crates/hive-net/target/debug/hive-net");
const PAGE = process.env.PHONE_PAGE ?? path.join(repoRoot, "crates/hive-web/www");
const keyCount = Number(process.argv[2] ?? 120);
const root = fs.mkdtempSync("/tmp/phone-echo-");
const nets: HiveNet[] = [];
const procs: Array<{ kill(signal: string): void }> = [];
process.on("exit", () => {
  for (const n of nets) n.stop();
  for (const p of procs) p.kill("SIGKILL");
  fs.rmSync(root, { recursive: true, force: true });
});
const warn = (m: string) => { if (process.env.VERBOSE) console.error(m); };
const quantile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!.toFixed(1);

// A relay, and a network naming it, signed by its admin.
const relayServer = spawn(BIN, ["serve", "--relay", "--data", path.join(root, "network"), "--bind", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "ignore"] });
procs.push(relayServer);
const relay = await new Promise<string>((resolve) => {
  let said = "";
  relayServer.stdout!.on("data", (d: Buffer) => { said += d; const m = /relay serving on (\S+)/.exec(said); if (m) resolve(m[1]!); });
});
const admin = path.join(root, "admin.key");
fs.writeFileSync(admin, `${"cd".repeat(32)}\n`);
const by = (JSON.parse(execFileSync(BIN, ["access", "voucher", "--kind", "enrol", "--admin", admin], { encoding: "utf8" })) as { by: string }).by;
fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify({ v: 1, name: "Echo", relays: [{ url: relay }], admin: by, local: { mdns: false } }));
const profile = path.join(root, "network.json");
fs.writeFileSync(profile, execFileSync(BIN, ["profile", "sign", path.join(root, "profile.json"), "--admin", admin], { encoding: "utf8" }));

// The PTY daemon, as the app runs it.
const ptySocket = path.join(root, "pty.sock");
const electronBin = createRequire(import.meta.url)("electron") as string;
procs.push(spawn(electronBin, ["out/main/pty-daemon.js", ptySocket], { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOME: root } }));
for (let i = 0; i < 200 && !fs.existsSync(ptySocket); i++) await Bun.sleep(50);

// The host, serving a workspace with one shell tile.
const hostIdentity = path.join(root, "host", "identity");
const keys = machineKeys(hostIdentity);
const store = new WorkspaceStore({ dir: path.join(root, "host", "workspaces"), person: keys.person });
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
store.setCore(repo, { v: 1, frames: [], tiles: [{ id: "t1", kind: "shell", label: "sh", cmd: "bash" }] });
const workspace = store.ownership(repo)!.workspaceId as string;
const intents = new Intents(new AuditLog({ file: path.join(root, "audit.jsonl") }));
const endpoint = new DaemonEndpoint({
  connect: async () => { const s = net.connect(ptySocket); await new Promise((r) => s.once("connect", r)); return s; },
  onEvent: () => {},
  env: () => process.env as Record<string, string>,
});
let server: WorkspaceServer;
const terminals = new Terminals({
  intents, backend: daemonSessions({ endpoint, pace: async () => {} }), onError: warn,
  relay: { record: () => {}, screenPrefix: REATTACH_RESET },
  publish: (event, ...params) => server.publish(event, ...params),
  who: () => ({ person: keys.personId, name: "" }),
});
server = new WorkspaceServer([...workspaceDomains, terminals.domain], intents);

// When host main is told of each letter, and first hands its echo to the phone's connection.
const seen = { typed: 0, echoed: 0 };
const notice = server.notice.bind(server);
server.notice = (method, params, from) => {
  if (method === "terminal.write" && (params as string[])[1] !== "\x7f") seen.typed = performance.now();
  notice(method, params, from);
};
const connect = server.connect.bind(server);
server.connect = (c: Connection) => {
  if (c.actor.kind === "peer") {
    const send = c.send;
    c.send = (e) => { if (e.event === "terminal.data" && !seen.echoed) seen.echoed = performance.now(); send(e); };
  }
  connect(c);
};

let phoneCertificate: DeviceCertificate | null = null;
const lists = new AccessLists({ dir: path.join(root, "host", "access"), owner: keys.person, devices: () => (phoneCertificate ? [phoneCertificate] : []) });
const links = new PeerLinks({
  store, changes: () => () => {}, lists, server, phone: () => true, onWarn: warn,
  machines: { self: () => ({ device: keys.deviceId, name: "desk" }), mine: () => undefined, whose: () => undefined, saved: () => undefined },
});
const host = await HiveNet.start({
  bin: BIN, identity: hostIdentity, socket: path.join(root, "host.sock"), profile, onWarn: warn,
  onIncoming: (link: Link) => {
    link.streams("echo", (s) => s.on((text) => s.send(text)));
    links.serve(link);
  },
  onPairRequest: async () => ({ ok: false }),
});
nets.push(host);
const local: Connection = { actor: { kind: "person" }, send: () => {}, closed: new AbortController().signal };
server.connect(local);
const started = await server.answer("terminal.open", [{ tileId: "hm:t1", tile: "t1", cwd: repo, cmd: "bash", args: ["--noprofile", "--norc", "-i"], env: { PS1: "$ ", HOME: root }, cols: 80, rows: 24 }], local);
if (!("result" in started)) throw new Error(`the shell did not start: ${JSON.stringify(started)}`);

// The host leg: the phone, a device of the host's person.
const phoneIdentity = path.join(root, "phone", "identity");
fs.mkdirSync(phoneIdentity, { recursive: true });
fs.writeFileSync(path.join(phoneIdentity, "device.key"), `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}\n`);
const phone = await HiveNet.start({ bin: BIN, identity: phoneIdentity, socket: path.join(root, "phone.sock"), onIncoming: () => {}, onPairRequest: async () => ({ ok: false }), onWarn: warn });
nets.push(phone);
phoneCertificate = certifyDevice(keys.person, phone.ready.id);
const pageSeed = crypto.getRandomValues(new Uint8Array(32));
host.admit([phone.ready.id, idOf(pageSeed)]);
const api = (await phone.dial(host.ready.id, { addrs: host.ready.addrs, relay: null })).open("api");
const session = "hm:t1";
let shown = "";
let taken = 0;
let acked = 0;
let answered = false;
api.on((text) => {
  const m = JSON.parse(text.startsWith("z:") ? Bun.inflateSync(Buffer.from(text.slice(2), "base64")).toString() : text);
  if (!Array.isArray(m) && "id" in m) answered = true;
  for (const e of Array.isArray(m) ? m : [m]) {
    if (e.event === "terminal.data" && e.params[0] === session) { shown += e.params[1]; taken += e.params[1].length; }
  }
  if (taken > acked) { acked = taken; api.send(JSON.stringify({ method: "terminal.ack", params: [session, taken] })); }
});
const notify = (method: string, ...params: unknown[]) => api.send(JSON.stringify({ method, params }));
api.send(JSON.stringify({ t: "open", workspace, z: "deflate" }));
api.send(JSON.stringify({ id: 1, method: "terminal.open", params: [{ tileId: session, tile: "t1", cwd: `hive://${workspace}`, cmd: "", cols: 40, rows: 30, attachOnly: true, liveOnly: true, acks: true, history: 1000 }] }));
while (!answered || !shown.includes("$ ")) await Bun.sleep(10);
notify("terminal.keyboard.ask", session);
notify("terminal.write", session, "x");
while (!shown.endsWith("x")) await Bun.sleep(5);
const legs = { total: [] as number[], toHost: [] as number[], inHost: [] as number[], toPhone: [] as number[] };
for (let i = 0; i < keyCount; i++) {
  const letter = String.fromCharCode(97 + (i % 26));
  const from = shown.length;
  seen.typed = 0;
  seen.echoed = 0;
  const at = performance.now();
  notify("terminal.write", session, "\x7f");
  notify("terminal.write", session, letter);
  while (!shown.slice(from).includes(letter)) await new Promise((r) => setImmediate(r));
  const back = performance.now();
  legs.total.push(back - at);
  legs.toHost.push(seen.typed - at);
  legs.inHost.push(seen.echoed - seen.typed);
  legs.toPhone.push(back - seen.echoed);
  await Bun.sleep(30);
}
console.log(`host leg: median ${quantile(legs.total, 0.5)} ms, p90 ${quantile(legs.total, 0.9)}, worst ${quantile(legs.total, 1)} (phone to host main ${quantile(legs.toHost, 0.5)}, host main to the shell and back ${quantile(legs.inHost, 0.5)}, host main to phone ${quantile(legs.toPhone, 0.5)}; ${keyCount} keys)`);

// The page leg.
if (!fs.existsSync(path.join(PAGE, "pkg", "hive_web_bg.wasm"))) {
  console.log("page leg: skipped, the page is not built (crates/hive-web/build.sh)");
} else {
  for (let i = 0; i < 100 && !host.ready.relay; i++) await Bun.sleep(100);
  const page = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
    const file = path.join(PAGE, path.normalize(new URL(req.url).pathname));
    if (!file.startsWith(PAGE) || !fs.existsSync(file)) return new Response("", { status: 404 });
    return new Response(Bun.file(file), { headers: file.endsWith(".wasm") ? { "content-type": "application/wasm" } : {} });
  } });
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    const query = new URLSearchParams({ relay, host: host.ready.id, n: "300", size: "40", seed: Buffer.from(pageSeed).toString("hex"), run: "1" });
    await tab.goto(`http://127.0.0.1:${page.port}/echo.html?${query}`);
    await tab.waitForFunction(() => (window as { result?: unknown }).result, null, { timeout: 60_000 });
    const r = await tab.evaluate(() => (window as unknown as { result: { p50: number; p95: number; max: number } }).result);
    console.log(`page leg: median ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)}, worst ${r.max.toFixed(1)} (300 frames)`);
  } finally {
    await browser.close();
    page.stop(true);
  }
}
console.log(`load ${os.loadavg()[0]!.toFixed(1)} on ${os.cpus().length} CPUs`);
process.exit(0);
