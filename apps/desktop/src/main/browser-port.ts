/**
 * The port agents drive browser tiles through (the hive-browser skill, `agent-browser --cdp`):
 * Chromium's DevTools port, passed through as it is, except keyboard input for a browser tile's
 * page, which is given to that page (page-keys.ts). On Chromium's own port it would go to whatever
 * holds focus in the app window.
 */
import http from "node:http";
import type { Duplex } from "node:stream";
import type { WebContents } from "electron";
import { WebSocket, WebSocketServer } from "ws";
import { keyboardCommand } from "./page-keys.js";

const KEYBOARD = new Set(["Input.insertText", "Input.dispatchKeyEvent"]);

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: { sessionId?: string };
}

/** Serve on 127.0.0.1:`port` the DevTools port Chromium listens on at `chromium`. `pageOf` names
 *  a browser tile's page by its DevTools target id. */
export function serveBrowserPort(port: number, chromium: number, pageOf: (targetId: string) => Promise<WebContents | null>): Promise<http.Server> {
  const theirs = `127.0.0.1:${chromium}`;
  const ours = `127.0.0.1:${port}`;
  // As Chromium's own port: only a loopback name, so a web page cannot reach it by renaming itself.
  const local = (host: string | undefined) => host === ours || host === `localhost:${port}`;

  const server = http.createServer((req, res) => {
    if (!local(req.headers.host)) { res.writeHead(403); res.end(); return; }
    const up = http.request({ host: "127.0.0.1", port: chromium, path: req.url, method: req.method, headers: { host: theirs } }, (r) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").split(theirs).join(ours).split(`localhost:${chromium}`).join(ours);
        res.writeHead(r.statusCode ?? 502, { "content-type": r.headers["content-type"] ?? "application/json; charset=UTF-8" });
        res.end(body);
      });
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // A web page always says where it comes from; the tools agents run never do. Chromium refuses it too.
    if (!local(req.headers.host) || req.headers.origin) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => relay(client, `ws://${theirs}${req.url ?? "/"}`, req.url ?? "/", pageOf));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(server); });
  });
}

/** One agent's connection, passed to Chromium's, but for keyboard input to a browser tile's page. */
function relay(client: WebSocket, to: string, path: string, pageOf: (targetId: string) => Promise<WebContents | null>): void {
  const upstream = new WebSocket(to, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  // The target each session is attached to; a connection to one page is that page's.
  const sessions = new Map<string, string>();
  const asked = new Map<number, string>();
  const own = /^\/devtools\/page\/([^/?]+)/.exec(path)?.[1];
  const waiting: string[] = [];
  const toChromium = (text: string) => (upstream.readyState === WebSocket.OPEN ? upstream.send(text) : waiting.push(text));
  const end = () => { client.terminate(); upstream.terminate(); };

  const keyboard = async (m: Message): Promise<boolean> => {
    const target = m.sessionId ? sessions.get(m.sessionId) : own;
    const page = target ? await pageOf(target) : null;
    if (!page || page.isDestroyed()) return false;
    const reply = (body: Record<string, unknown>) => client.send(JSON.stringify({ id: m.id, ...body, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    try {
      await keyboardCommand(page, m.method!, m.params ?? {});
      reply({ result: {} });
    } catch (e) {
      reply({ error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
    }
    return true;
  };

  // In order: a read sent after a key must not overtake it.
  let queue = Promise.resolve();
  client.on("message", (data) => {
    const text = data.toString();
    queue = queue.then(async () => {
      if (text.includes('"Input.') || text.includes('"Target.attachToTarget"')) {
        let m: Message | null = null;
        try { m = JSON.parse(text) as Message; } catch { /* not ours to read */ }
        if (m?.method === "Target.attachToTarget" && typeof m.id === "number") asked.set(m.id, String(m.params?.targetId ?? ""));
        if (m?.method && KEYBOARD.has(m.method) && (await keyboard(m))) return;
      }
      toChromium(text);
    });
  });

  upstream.on("open", () => { for (const text of waiting.splice(0)) upstream.send(text); });
  upstream.on("message", (data) => {
    const text = data.toString();
    if (text.includes("Target.attachedToTarget") || text.includes("Target.detachedFromTarget") || (asked.size && text.includes('"sessionId"'))) {
      try {
        const m = JSON.parse(text) as Message & { params?: { sessionId?: string; targetInfo?: { targetId?: string } } };
        if (m.method === "Target.attachedToTarget" && m.params?.sessionId && m.params.targetInfo?.targetId) sessions.set(m.params.sessionId, m.params.targetInfo.targetId);
        if (m.method === "Target.detachedFromTarget" && m.params?.sessionId) sessions.delete(m.params.sessionId);
        if (typeof m.id === "number" && asked.has(m.id)) {
          if (m.result?.sessionId) sessions.set(m.result.sessionId, asked.get(m.id)!);
          asked.delete(m.id);
        }
      } catch { /* passed on as it is */ }
    }
    if (client.readyState === WebSocket.OPEN) client.send(text);
  });
  client.on("close", end);
  client.on("error", end);
  upstream.on("close", end);
  upstream.on("error", end);
}
