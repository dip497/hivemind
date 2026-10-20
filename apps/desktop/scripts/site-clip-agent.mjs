// A stand-in coding agent for the hero recording (scripts/site-clip.mjs), run as claude, codex or
// pi. It keeps the recording's clock (`$CLIP_CUE/clock`, in ms), so a recording drawn one frame at a
// time shows it at its own pace, and it ends each turn through the host SDK the way a hooked agent
// does.
//   lead: shows `steps/0.sh`, then each line typed at its prompt runs the next `steps/<n>.sh`.
//   any other: a turn starts on `work <task>` in `$CLIP_CUE/<tile>` and ends on `finish`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const kind = process.argv[2] ?? "claude";
const lead = process.argv.slice(3).includes("lead");
const CUE = process.env.CLIP_CUE ?? "";
const tile = (process.env.HIVEMIND_TILE ?? "").replace(/^hm:/, "");
const sdk = (() => { try { return createRequire(import.meta.url)(process.env.HIVE_SDK); } catch { return null; } })();
const out = (s) => process.stdout.write(s);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dim = (s) => `\x1b[2m${s}\x1b[22m`, bold = (s) => `\x1b[1m${s}\x1b[22m`;
const col = (n, s) => `\x1b[38;5;${n}m${s}\x1b[39m`;

const started = Date.now();
function now() {
  try { const v = Number(fs.readFileSync(path.join(CUE, "clock"), "utf8")); if (v > 0) return v; } catch { /* not written yet */ }
  return Date.now() - started;
}
async function sleep(ms) { const end = now() + ms; while (now() < end) await realSleep(20); }

const STYLE = {
  claude: { accent: 209, prompt: "❯ ", bullet: "⏺", spin: ["·", "✢", "✳", "✶", "✻", "✽"] },
  codex: { accent: 252, prompt: "› ", bullet: "•", spin: ["◐", "◓", "◑", "◒"] },
  pi: { accent: 111, prompt: "π ", bullet: "→", spin: ["·", "•", "●", "•"] },
}[kind];

// What each project's agent does in a turn, and what it says when the turn ends.
const WORK = {
  cart: { steps: [["Read", "src/cart/totals.ts"], ["Edit", "src/cart/totals.ts"], ["Bash", "bun test cart"]], said: ["Done: the cart total rounds once, at checkout.", "Done: a coupon applies once, and its test passes."] },
  search: { steps: [["Read", "src/search/query.ts"], ["Edit", "src/search/query.ts"], ["Bash", "bun test search"]], said: ["Done: search ignores accents now.", "Done: exact matches rank first."] },
  refunds: { steps: [["Read", "src/refunds/handler.ts"], ["Edit", "src/refunds/handler.ts"], ["Bash", "go test ./refunds"]], said: ["Done: the refund webhook retries on a timeout.", "Done: a refund is never sent twice."] },
  docs: { steps: [["Read", "guides/quickstart.md"], ["Edit", "guides/quickstart.md"], ["Bash", "npm run build"]], said: ["Done: the quickstart starts with the CLI.", "Done: every guide builds."] },
  login: { steps: [["Read", "app/screens/Login.tsx"], ["Edit", "app/screens/Login.tsx"], ["Bash", "npm run lint"]], said: ["Done: the login button shows a spinner.", "Done: the spinner stops when sign-in fails."] },
};
const topic = (task) => Object.keys(WORK).find((k) => task.toLowerCase().includes(k)) ?? "cart";
const said = {};

const emit = async (event) => { try { await sdk?.emit(event); } catch { /* the host is gone */ } };
const reply = async (text) => { try { await sdk?.reportReply(text); } catch { /* the host is gone */ } };

let spinner = null, label = "";
const drawSpin = () => out(`\r\x1b[2K${col(STYLE.accent, STYLE.spin[Math.floor(now() / 120) % STYLE.spin.length])} ${label}… ${dim("(esc to interrupt)")}`);
const spin = (what) => { label = what; drawSpin(); spinner = setInterval(drawSpin, 30); };
const unspin = () => { if (spinner) clearInterval(spinner); spinner = null; out("\r\x1b[2K"); };
const line = (tool, arg) => { unspin(); out(`${col(STYLE.accent, STYLE.bullet)} ${bold(tool)}(${arg})\n  ${dim("⎿")}  ${tool === "Bash" ? "passed" : tool === "Edit" ? "updated" : "read"}\n`); };
const prompt = () => out(`\n${col(STYLE.accent, STYLE.prompt)}`);

const runStep = (n) => new Promise((resolve) => {
  const file = path.join(os.homedir(), "steps", `${n}.sh`);
  if (!fs.existsSync(file)) return resolve();
  spawn("bash", [file], { stdio: ["ignore", "inherit", "inherit"] }).on("close", resolve);
});

let busy = false, finish = false, asked = 0;
async function turn(task) {
  busy = true;
  finish = false;
  await emit("turn.started");
  if (lead) {
    await runStep(++asked);
    await emit("turn.ended");
  } else {
    const k = topic(task);
    const { steps } = WORK[k];
    let step = 0, next = now() + 1500;
    spin("Working");
    while (!finish) {
      if (step < steps.length && now() >= next) { line(...steps[step++]); spin("Working"); next = now() + 1700; }
      await realSleep(25);
    }
    while (step < steps.length) line(...steps[step++]);
    unspin();
    const text = WORK[k].said[(said[k] = (said[k] ?? -1) + 1) % WORK[k].said.length];
    out(`\n${STYLE.bullet} ${text}\n`);
    await reply(text);
    await emit("turn.ended");
  }
  busy = false;
  prompt();
}

out("\x1b[2J\x1b[H\x1b[?25l");
// No text cursor in the shot.
setInterval(() => out("\x1b[?25l"), 250);
if (lead) await runStep(0);
prompt();

let typed = "";
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  for (const ch of d) {
    if (ch === "\x03") process.exit(0);
    if (busy) continue;
    if (ch === "\r" || ch === "\n") {
      const task = typed.trim();
      typed = "";
      out("\r\n");
      if (task) void turn(task); else prompt();
    } else if (ch === "\x7f") { if (typed) { typed = typed.slice(0, -1); out("\b \b"); } }
    else if (ch >= " ") { typed += ch; out(ch); }
  }
});
setInterval(() => {
  if (!CUE || !tile) return;
  let cue = "";
  try { const f = path.join(CUE, tile); cue = fs.readFileSync(f, "utf8").trim(); fs.rmSync(f); } catch { return; }
  if (cue === "finish") finish = true;
  else if (cue.startsWith("work ") && !busy) { out(`${cue.slice(5)}\r\n`); void turn(cue.slice(5)); }
}, 40);
