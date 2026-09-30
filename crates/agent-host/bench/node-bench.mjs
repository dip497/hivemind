// The daemon's hot path in the TypeScript host: N PTYs streaming into a headless xterm, the
// screen read every 1.2s. Prints this process's CPU and RSS. Usage: node node-bench.mjs <n> <secs> <script>
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const req = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/agent-host/package.json"));
const pty = req("@lydell/node-pty");
const { Terminal } = req("@xterm/headless");
const [n, secs, script] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
const sessions = [];
for (let i = 0; i < n; i++) {
  const term = new Terminal({ cols: 100, rows: 24, scrollback: 5000, allowProposedApi: true });
  const p = pty.spawn("bash", [script], { cols: 100, rows: 24, name: "xterm-256color", env: process.env });
  p.onData((d) => term.write(d));
  sessions.push({ term, p });
}
const screen = (term) => { const b = term.buffer.active; let out = ""; for (let y = 0; y < term.rows; y++) out += (b.getLine(b.baseY + y)?.translateToString(true) ?? "") + "\n"; return out; };
await new Promise((r) => setTimeout(r, 3000));
const c0 = process.cpuUsage(), t0 = Date.now();
let chars = 0;
while (Date.now() - t0 < secs * 1000) {
  await new Promise((r) => setTimeout(r, 1200));
  for (const s of sessions) chars += screen(s.term).length;
}
const wall = (Date.now() - t0) / 1000, c = process.cpuUsage(c0);
console.log(JSON.stringify({ host: "typescript", sessions: n, cpuPct: Math.round(((c.user + c.system) / 1e6 / wall) * 1000) / 10, rssMb: Math.round(process.memoryUsage().rss / 1048576), screenChars: chars }));
for (const s of sessions) s.p.kill();
process.exit(0);
