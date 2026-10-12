/**
 * The control plane's door for an agent whose hooks are http requests (spec/hook-protocol.md
 * "Over http"): a request is what the event script would have said on the socket, said there by
 * this process. An answering request is held until the answer, and costs an open connection
 * instead of a process. Loopback only, and a request is its tile's by the tile's own token.
 */
import http from "node:http";
import net from "node:net";
import { answerIn, hookLines } from "./hook-lines.js";

export interface HookHttp { url: string; close: () => void }

const MAX_BODY = 4 * 1024 * 1024;

export function startHookHttp(o: { sock: string; tileOf: (token: string) => string | undefined }): Promise<HookHttp> {
  const server = http.createServer((req, res) => {
    const empty = (status = 200) => { if (!res.headersSent) { res.writeHead(status, { "content-length": "0" }); res.end(); } };
    const url = new URL(req.url ?? "/", "http://hook");
    const { port } = server.address() as net.AddressInfo;
    // A page in a browser can reach loopback too: it says where it is from, and a name rebound to
    // loopback arrives under that name, so either is refused before anything is read.
    if (req.method !== "POST" || url.pathname !== "/event" || req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}`) return empty(404);
    const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    const tile = token ? o.tileOf(token) : undefined;
    const event = url.searchParams.get("event") ?? "";
    if (!tile || !event) return empty(403);
    const answer = url.searchParams.get("answer") === "1";
    let body = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (d: string) => { size += d.length; if (size > MAX_BODY) req.destroy(); else body += d; });
    req.on("end", () => {
      let e: Record<string, unknown> = {};
      try { e = JSON.parse(body) || {}; } catch { /* reported without its ids */ }
      const lines = hookLines({ event, kind: url.searchParams.get("kind") ?? undefined, outcome: url.searchParams.get("outcome") ?? undefined, answer }, tile, token, e);
      const c = net.connect(o.sock, () => {
        c.write(lines.map((l) => JSON.stringify(l) + "\n").join(""));
        if (!answer) { c.end(); empty(); }
      });
      // The agent gave up (its own prompt was answered, or Esc): the host lets go of the wait.
      res.on("close", () => c.destroy());
      c.on("error", () => empty());
      c.on("close", () => empty());
      if (!answer) return;
      let buf = "";
      c.setEncoding("utf8");
      c.on("data", (d: string) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          let m: unknown = null;
          try { m = JSON.parse(buf.slice(0, nl)); } catch { /* not ours */ }
          buf = buf.slice(nl + 1);
          const said = answerIn(m);
          if (said === undefined) continue;
          if (!said) empty();
          else if (!res.headersSent) { res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(said)) }); res.end(said); }
          c.destroy();
          return;
        }
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
