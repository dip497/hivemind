/**
 * The control plane's door for the native hook (`hive-net hook`, spec/hook-protocol.md "The native
 * hook"): a connection is what the event script would have said on the control socket, said there
 * by this process. A held answer costs that small program and an open connection; its end (the
 * agent answered its own prompt, Esc, a timeout) lets go of the wait.
 */
import fs from "node:fs";
import net from "node:net";
import { EVENT_ENV } from "@hivemind/agents";
import { answerIn, hookLines } from "./hook-lines.js";

export interface HookDoor { path: string; close: () => void }

const MAX_LINE = 4 * 1024 * 1024;

/** Open the door on `path`, passing what each hook says on to the control socket `sock`. */
export function startHookDoor(o: { path: string; sock: string }): Promise<HookDoor> {
  try { fs.unlinkSync(o.path); } catch { /* none */ }
  const server = net.createServer((conn) => {
    let buf = "";
    let up: net.Socket | undefined;
    let held: net.Socket | undefined;
    conn.setEncoding("utf8");
    conn.on("error", () => {});
    // The agent ended its hook: the host lets go of the wait.
    conn.on("close", () => held?.destroy());
    conn.on("data", (d: string) => {
      if (up) return;
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) { if (buf.length > MAX_LINE) conn.destroy(); return; }
      let said: { env?: Record<string, string>; stdin?: string } = {};
      try { said = JSON.parse(buf.slice(0, nl)) ?? {}; } catch { /* nothing to report */ }
      const env = said.env ?? {};
      const tile = env.HIVEMIND_TILE ?? "";
      const event = env[EVENT_ENV.event] ?? "";
      if (!tile || !event) { conn.end(); return; }
      let e: Record<string, unknown> = {};
      try { e = JSON.parse(said.stdin ?? "") || {}; } catch { /* reported without its ids */ }
      const answer = env[EVENT_ENV.answer] === "1";
      const lines = hookLines({ event, kind: env[EVENT_ENV.kind], outcome: env[EVENT_ENV.outcome], answer }, tile, env.HCP_TOKEN ?? "", e);
      const c = up = net.connect(o.sock, () => {
        c.write(lines.map((l) => JSON.stringify(l) + "\n").join(""));
        if (!answer) { c.end(); conn.end(); }
      });
      c.on("error", () => conn.end());
      c.on("close", () => conn.end());
      if (!answer) return;
      held = c;
      let rest = "";
      c.setEncoding("utf8");
      c.on("data", (r: string) => {
        rest += r;
        let i;
        while ((i = rest.indexOf("\n")) >= 0) {
          let m: unknown = null;
          try { m = JSON.parse(rest.slice(0, i)); } catch { /* not ours */ }
          rest = rest.slice(i + 1);
          const out = answerIn(m);
          if (out === undefined) continue;
          conn.end(out);
          c.destroy();
          return;
        }
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.path, () => {
      try { fs.chmodSync(o.path, 0o600); } catch { /* best-effort */ }
      resolve({ path: o.path, close: () => { server.close(); try { fs.unlinkSync(o.path); } catch { /* gone */ } } });
    });
  });
}
