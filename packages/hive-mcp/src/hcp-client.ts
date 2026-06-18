/**
 * HCP client for the hive MCP — lets an agent drive the RUNNING hivemind app
 * (spawn sibling agents on the canvas, send them input, read their replies).
 *
 * Connects to the control-plane unix socket whose path + capability token were
 * injected into this agent's env (HIVE_HCP_SOCK / HCP_TOKEN) when hivemind
 * spawned it. One short-lived connection per call (NDJSON, one `req`/`res`).
 * When the app isn't running the env is absent / the socket refuses — surfaced
 * as a clear error so the issue tools (which are file-only) keep working.
 */
import net from "node:net";
import { randomUUID } from "node:crypto";

export function hcpAvailable(): boolean {
  return !!process.env.HIVE_HCP_SOCK;
}

export function hcpCall(method: string, params: unknown, timeoutMs = 130_000): Promise<unknown> {
  const sock = process.env.HIVE_HCP_SOCK;
  const token = process.env.HCP_TOKEN;
  if (!sock) {
    return Promise.reject(new Error("hivemind app not running (HIVE_HCP_SOCK unset) — canvas tools need the desktop app open"));
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let buf = "";
    let settled = false;
    const c = net.connect(sock, () => {
      try { c.write(JSON.stringify({ t: "req", id, method, params, token }) + "\n"); } catch (e) { fail(e as Error); }
    });
    c.setEncoding("utf8");
    const timer = setTimeout(() => fail(new Error("HCP request timed out")), timeoutMs);
    timer.unref?.();
    function ok(v: unknown) { if (settled) return; settled = true; clearTimeout(timer); try { c.end(); } catch { /* */ } resolve(v); }
    function fail(e: Error) { if (settled) return; settled = true; clearTimeout(timer); try { c.destroy(); } catch { /* */ } reject(e); }
    c.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let m: { t?: string; id?: string; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.t === "hello") continue;
        if (m.t === "res" && m.id === id) {
          if (m.ok) return ok(m.result);
          return fail(new Error(m.error?.message || m.error?.code || "HCP error"));
        }
      }
    });
    c.on("error", (e: Error) => fail(new Error(`hivemind app not reachable: ${e.message}`)));
    c.on("close", () => fail(new Error("HCP connection closed before a reply")));
  });
}
