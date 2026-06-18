/**
 * plan-bridge — the Electron-main side of plan review. A unix-domain socket the
 * injected PreToolUse hook (plan-review-hook.cjs) connects to when an agent
 * hands off a plan. Each connection carries ONE plan; the bridge surfaces it to
 * the app via `onRequest` and holds the connection open until the app calls
 * `reply(decision, feedback)` — at which point the decision is written back and
 * the agent unblocks.
 *
 * Transport: NDJSON (one JSON object per line), same style as the pty daemon.
 * Trust: the socket file is mode 0600 under <userData>, so only the user's own
 * processes can reach it — same posture as the pty-daemon socket. No network.
 */
import net from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

export interface PlanRequest {
  requestId: string;
  tileId: string;
  plan: string;
  cwd: string;
  /** Resolve the held hook connection. allow → agent proceeds; deny+feedback →
   *  agent revises. Idempotent; later calls are ignored. */
  reply: (decision: "allow" | "deny", feedback?: string) => void;
  /** Fires if the hook connection drops before a decision (agent killed, app
   *  reload). Lets the app close any open review tile for this request. */
  onAbort: (cb: () => void) => void;
}

export interface PlanBridge {
  close: () => void;
}

/** Bind the bridge to `sockPath`. `onRequest` is invoked once per plan handoff. */
export function startPlanBridge(
  sockPath: string,
  onRequest: (req: PlanRequest) => void,
): PlanBridge {
  // A stale socket file from a previous run blocks listen() with EADDRINUSE.
  try { fs.unlinkSync(sockPath); } catch { /* none / not ours — listen will surface real errors */ }

  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buf = "";
    let handled = false;
    let replied = false;
    const abortCbs: Array<() => void> = [];

    const reply = (decision: "allow" | "deny", feedback?: string) => {
      if (replied) return;
      replied = true;
      try { conn.write(JSON.stringify({ decision, feedback }) + "\n"); } catch { /* gone */ }
      try { conn.end(); } catch { /* gone */ }
    };

    conn.on("data", (chunk: string) => {
      if (handled) return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      let msg: { tileId?: string; plan?: string; cwd?: string };
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch {
        reply("allow");
        return;
      }
      if (!msg.plan) { reply("allow"); return; }
      onRequest({
        requestId: randomUUID(),
        tileId: msg.tileId ?? "",
        plan: msg.plan,
        cwd: msg.cwd ?? "",
        reply,
        onAbort: (cb) => abortCbs.push(cb),
      });
    });

    // Hook connection dropped before a decision → tell the app to close the tile.
    conn.on("close", () => { if (!replied) for (const cb of abortCbs) try { cb(); } catch { /* ignore */ } });
    conn.on("error", () => { /* client gone; close handler does cleanup */ });
  });

  server.on("error", (err) => {
    // Best-effort: a bridge that can't bind just means plan review is off; the
    // hook fails open, so the agent still works.
    console.error("[plan-bridge] listen error:", err);
  });
  server.listen(sockPath, () => {
    try { fs.chmodSync(sockPath, 0o600); } catch { /* best-effort */ }
  });

  return {
    close: () => {
      try { server.close(); } catch { /* ignore */ }
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    },
  };
}
