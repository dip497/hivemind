// Whose a session's terminal is (foreground.ts), as Linux tells it: a shell holds its terminal at
// its prompt, and a command it runs holds it while it runs. A tile's line shows that command's
// question and passes over the shell's prompt by it.
import { expect, test } from "bun:test";
import { spawn } from "../src/bun-pty.ts";
import { holdsTerminal } from "../src/foreground.ts";

/** Waits up to 5 s for `ok`. */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 250 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(ok()).toBe(true);
}

test.skipIf(process.platform !== "linux")("a shell holds its terminal at its prompt, and a command it runs holds it until it ends", async () => {
  const sh = spawn("bash", ["--norc", "--noprofile", "-i"], { cwd: "/", cols: 80, rows: 24, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PS1: "$ " } });
  let out = "";
  sh.onData((d) => { out += d; });
  try {
    await until(() => out.includes("$ "));
    expect(holdsTerminal(sh.pid)).toBe(true);
    sh.write("sleep 30\r");
    await until(() => holdsTerminal(sh.pid) === false);
    // Ctrl+C ends it, and the shell takes its terminal back.
    sh.write("\x03");
    await until(() => holdsTerminal(sh.pid) === true);
  } finally {
    sh.kill("SIGKILL");
  }
});
