// Real end-to-end proof of tmux-style persistence: starts the ACTUAL daemon
// (electron-as-node so the real node-pty binding loads, no display needed),
// runs a shell, disconnects (simulating the window closing), reconnects, and
// asserts the session survived + its output replays. Run via run-daemon-itest.sh.
import net from "node:net";
import { spawn } from "node:child_process";

const ELECTRON = process.argv[2];
const DAEMON = process.argv[3];
const SOCK = process.argv[4];

const frame = (o) => JSON.stringify(o) + "\n";
function reader(sock, onMsg) {
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onMsg(JSON.parse(line));
    }
  });
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () =>
  new Promise((res, rej) => {
    const s = net.connect(SOCK);
    s.once("connect", () => res(s));
    s.once("error", rej);
  });

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

const daemon = spawn(ELECTRON, [DAEMON, SOCK], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});

const id = "repo:itest-1";
const spec = { cwd: process.cwd(), cmd: "bash", args: ["--norc", "-i"], cols: 80, rows: 24 };

try {
  // wait for the daemon to bind the socket
  let s1;
  for (let i = 0; i < 40; i++) {
    try { s1 = await connect(); break; } catch { await delay(100); }
  }
  if (!s1) fail("daemon never bound the socket");

  let firstData = "";
  let attached1 = false;
  reader(s1, (m) => {
    if (m.t === "attached") attached1 = true;
    if (m.t === "data") firstData += m.data;
  });
  s1.write(frame({ t: "attach", reqId: "1", id, spec }));
  await delay(400);
  if (!attached1) fail("no 'attached' reply");

  // run a command whose output we can look for after reattach
  s1.write(frame({ t: "write", id, data: "echo PERSIST_MARKER_42\n" }));
  await delay(500);
  if (!firstData.includes("PERSIST_MARKER_42")) fail("command output not seen on first client");

  // simulate window close — drop the connection (daemon should DETACH, not kill)
  s1.destroy();
  await delay(500);

  // reconnect (relaunch) and reattach the SAME id — expect replay + same pid
  const s2 = await connect();
  let replay = "";
  let pid2 = null;
  let isNew2 = null;
  reader(s2, (m) => {
    if (m.t === "attached") { pid2 = m.pid; isNew2 = m.isNew; replay += m.replay; }
    if (m.t === "data") replay += m.data;
  });
  s2.write(frame({ t: "attach", reqId: "2", id, spec }));
  await delay(500);

  if (isNew2 !== false) fail(`expected reattach (isNew=false), got isNew=${isNew2}`);
  if (!replay.includes("PERSIST_MARKER_42")) fail("replay did NOT contain prior output — session lost!");

  // session still live: run another command, see it stream
  let liveData = "";
  reader(s2, (m) => { if (m.t === "data") liveData += m.data; });
  s2.write(frame({ t: "write", id, data: "echo STILL_ALIVE_99\n" }));
  await delay(500);
  if (!liveData.includes("STILL_ALIVE_99")) fail("session not live after reattach");

  // explicit kill ends it
  s2.write(frame({ t: "kill", id }));
  await delay(300);
  s2.write(frame({ t: "list", reqId: "3" }));
  let listed = null;
  reader(s2, (m) => { if (m.t === "sessions") listed = m.ids; });
  await delay(300);
  if (listed && listed.includes(id)) fail("session still present after kill");

  s2.destroy();
  console.log("PASS: persistence proven (attach → output → disconnect → reattach → replay → live → kill)");
  process.exit(0);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  try { daemon.kill("SIGKILL"); } catch { /* ignore */ }
}
