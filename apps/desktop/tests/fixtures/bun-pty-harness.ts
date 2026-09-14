// Run under bun by tests/unit/bun-pty.test.ts; prints one JSON line of observations.
import { spawn } from "../../src/main/bun-pty.ts";

const p = spawn("bash", ["--norc", "--noprofile"], { cwd: "/tmp", cols: 80, rows: 24, env: { ...(process.env as Record<string, string>), PS1: "$ " } });
let out = "";
p.onData((d) => { out += d; });
const res: Record<string, unknown> = { pid: p.pid > 0 };
const until = async (s: string, ms = 5000) => { for (let t = 0; t < ms && !out.includes(s); t += 20) await new Promise((r) => setTimeout(r, 20)); return out.includes(s); };
p.onExit(({ exitCode }) => {
  res.exitCode = exitCode;
  res.tailBeforeExit = out.includes("BYE-99");
  console.log(JSON.stringify(res));
  process.exit(0);
});
p.write("echo IN-$((20+22)); stty size; printf '%s' $PWD; echo\n");
res.input = await until("IN-42");
res.size = await until("24 80");
res.pwd = await until("/tmp");
p.resize(132, 40);
p.write("stty size\n");
res.resize = await until("40 132");
p.write("printf 'é日本'; echo\n");
res.utf8 = await until("é日本");
p.pause();
const before = out.length;
p.write("seq 1 200000; echo SEQ-$((1+1))-DONE\n");
await new Promise((r) => setTimeout(r, 400));
res.pausedHeld = out.length === before;
p.resume();
res.resumed = (await until("SEQ-2-DONE", 15000)) && out.includes("199999");
p.write("echo BYE-$((9*11)); exit 7\n");
