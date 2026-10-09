/**
 * The drive socket from the command line: the workspace API of the running app or `hive host`,
 * as the person at this machine (the install's token), one call per connection.
 */
import fs from "node:fs";
import net from "node:net";
import { ipcPath } from "@hivemind/core";
import { appData } from "./app-data.js";
import { EXIT, HcpCliError, token } from "./hcp.js";

/** Where programs drive this machine: `HIVE_DRIVE_SOCK`, else the app's data folder. */
export function driveSockPath(): string {
  return process.env.HIVE_DRIVE_SOCK || ipcPath(appData(), "drive.sock");
}

const CODES: Record<string, number> = { BAD_REQUEST: EXIT.usage, UNKNOWN_METHOD: EXIT.usage, FORBIDDEN: EXIT.unauthorized };

/** Call `method` with `params` on the drive socket, as the person. */
export function driveCall(method: string, params: unknown[], timeoutMs = 10_000): Promise<unknown> {
  const sock = driveSockPath();
  if (process.platform !== "win32" && !fs.existsSync(sock)) {
    return Promise.reject(new HcpCliError("UNAVAILABLE", `neither the hivemind app nor \`hive host\` is running (no socket at ${sock})`, EXIT.unavailable));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (e: Error | null, v?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      c.destroy();
      if (e) reject(e);
      else resolve(v);
    };
    const timer = setTimeout(() => done(new HcpCliError("TIMEOUT", `no answer within ${timeoutMs} ms`, EXIT.timeout)), timeoutMs);
    const c = net.connect(sock, () => {
      c.write(`${JSON.stringify({ hello: { token: token() } })}\n${JSON.stringify({ id: 1, method, params })}\n`);
    });
    c.setEncoding("utf8");
    let buf = "";
    c.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: { id?: unknown; result?: unknown; error?: { code?: string; message?: string } };
        try { m = JSON.parse(line) as typeof m; } catch { continue; }
        if (m.error) {
          const code = m.error.code ?? "FAILED";
          return done(new HcpCliError(code, m.error.message ?? code, CODES[code] ?? EXIT.error));
        }
        if (m.id === 1) return done(null, m.result);
      }
    });
    c.on("error", (e) => done(new HcpCliError("UNAVAILABLE", `the drive socket is not answering: ${e.message}`, EXIT.unavailable)));
    c.on("close", () => done(new HcpCliError("UNAVAILABLE", "the drive socket closed before it answered", EXIT.unavailable)));
  });
}
