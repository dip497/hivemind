/**
 * The app in a browser (docs/design/browser-app-2026-10-13.md): the built renderer and one socket
 * carrying the window's IPC channels, on 127.0.0.1. Every request needs the cookie the link's
 * token is traded for, and the socket the token itself in its first frame. Electron-free.
 */
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebStream } from "node:stream/web";
import { WebSocketServer, WebSocket } from "ws";
import { cookieName, cookieOf, hostAllowed, sameOrigin, sameToken, sessionCookie, viewsKey } from "./browser-gate.js";
import { CLOSE_UNAUTHORIZED, KEYED_SCHEME, SESSION_PATH, SOCKET_PATH, TOKEN_KEY, schemeOf, viewBase, type MainFrame, type TabFrame } from "../shared/browser-socket.js";
import { withOwnFiles } from "@hivemind/core/view-files";

/** A browser tab, to main as a window is: it is sent events, and it goes. */
export interface Tab {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): void;
}

/** The channels a tab may use, answered as a window's are. */
export interface TabChannels {
  served(): readonly string[];
  invoke(channel: string, tab: Tab, args: unknown[]): unknown;
  send(channel: string, tab: Tab, args: unknown[]): void;
}

export interface BrowserServerOptions {
  /** 0 takes any free port. */
  port: number;
  /** Host names besides 127.0.0.1 and localhost (a tailnet name `tailscale serve` passes on). */
  names: readonly string[];
  token: string;
  /** The built renderer, and the page in it a tab opens. */
  root: string;
  page: string;
  platform: string;
  channels: TabChannels;
  /** The handler that answers one of the app's schemes, as it answers a window. */
  schemes(scheme: string): ((request: Request) => Response | Promise<Response>) | undefined;
  onTab(tab: Tab): void;
  onError(message: string): void;
}

export interface BrowserServer {
  port: number;
  close(): Promise<void>;
}

const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
  "cache-control": "no-cache",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** What a request without the cookie is shown: it trades the link's token for one. */
const SIGN_IN = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>hivemind</title>
<body style="background:#0d0e12;color:#e7e9ee;font:14px system-ui,sans-serif;padding:24px">
<p id="m">Open the link the app shows in Settings → Advanced → In a browser.</p>
<script>(async () => {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!token) return;
  history.replaceState(null, "", location.pathname);
  const r = await fetch(${JSON.stringify(SESSION_PATH)}, { method: "POST", headers: { "content-type": "text/plain" }, body: token });
  if (!r.ok) { document.getElementById("m").textContent = "This link is from before the app last started. Open the one Settings → Advanced → In a browser shows now."; return; }
  try { localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, token); } catch {}
  location.reload();
})();</script>`;

/** JSON would hand the tab something else than main gave (a Date as text, bytes as an object). */
function json(frame: MainFrame): string {
  return JSON.stringify(frame, function (this: Record<string, unknown>, key, value) {
    const raw = this[key];
    if (raw instanceof Date || raw instanceof Map || raw instanceof Set || raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      throw new Error(`${key || "the value"} is not JSON and cannot reach a browser`);
    }
    return value;
  });
}

class SocketTab implements Tab {
  private readonly gone = new AbortController();

  constructor(private readonly ws: WebSocket, private readonly onError: (message: string) => void) {
    ws.once("close", () => this.gone.abort());
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(json({ t: "event", ch: channel, args }));
    } catch (e) {
      this.onError(`${channel}: ${(e as Error).message}`);
    }
  }

  isDestroyed(): boolean {
    return this.gone.signal.aborted;
  }

  once(_event: "destroyed", listener: () => void): void {
    if (this.gone.signal.aborted) listener();
    else this.gone.signal.addEventListener("abort", listener, { once: true });
  }
}

export function serveBrowser(opts: BrowserServerOptions): Promise<BrowserServer> {
  const root = path.resolve(opts.root);
  const key = viewsKey(opts.token);
  let port = opts.port;
  const signedIn = (req: http.IncomingMessage): boolean => {
    const cookie = cookieOf(req.headers.cookie, cookieName(port));
    return cookie !== null && sameToken(cookie, opts.token);
  };
  const deny = (res: http.ServerResponse, status: number, why: string): void => {
    res.writeHead(status, { ...HEADERS, "content-type": "text/plain; charset=utf-8" }).end(why);
  };

  async function file(pathname: string, res: http.ServerResponse): Promise<void> {
    let rel: string;
    try {
      rel = pathname === "/" ? opts.page : decodeURIComponent(pathname).slice(1);
    } catch {
      return deny(res, 400, "bad path");
    }
    const abs = path.resolve(root, rel);
    const inside = path.relative(root, abs);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return deny(res, 404, "not found");
    try {
      const body = await fs.readFile(abs);
      res.writeHead(200, { ...HEADERS, "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream" }).end(body);
    } catch {
      deny(res, 404, "not found");
    }
  }

  /** One of the app's schemes, as its handler answers it; a view's under the handler's own policy. */
  async function scheme(at: NonNullable<ReturnType<typeof schemeOf>>, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const handler = opts.schemes(at.scheme);
    if (!handler) return deny(res, 404, "not found");
    const range = req.headers.range;
    const answer = await handler(new Request(at.url, { headers: range ? { range } : {} }));
    const headers: Record<string, string> = at.scheme === KEYED_SCHEME ? { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" } : { ...HEADERS };
    answer.headers.forEach((value, name) => { headers[name] = value; });
    // A view loads and fetches its own files at its own path here, every view being a path on this server.
    const csp = headers["content-security-policy"];
    if (at.scheme === KEYED_SCHEME && csp) {
      const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      headers["content-security-policy"] = withOwnFiles(csp, `${proto}://${req.headers.host}${viewBase(new URL(at.url).host, at.key!)}`);
    }
    res.writeHead(answer.status, headers);
    if (req.method === "HEAD" || !answer.body) return void res.end();
    Readable.fromWeb(answer.body as WebStream).on("error", () => res.destroy()).pipe(res);
  }

  async function session(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!sameOrigin(req.headers.origin, req.headers.host)) return deny(res, 403, "only this server's own page signs in");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024) return deny(res, 413, "too long");
    }
    if (!sameToken(body.trim(), opts.token)) return deny(res, 401, "not this launch's token");
    const secure = req.headers["x-forwarded-proto"] === "https";
    res.writeHead(204, { ...HEADERS, "set-cookie": sessionCookie(port, opts.token, secure) }).end();
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      if (!hostAllowed(req.headers.host, opts.names)) return deny(res, 403, "this server answers to its own names only");
      const { pathname } = new URL(req.url ?? "/", "http://host");
      if (req.method === "POST" && pathname === SESSION_PATH) return session(req, res);
      if (req.method !== "GET" && req.method !== "HEAD") return deny(res, 405, "not allowed");
      const at = schemeOf(pathname, new URL(req.url ?? "/", "http://host").search);
      if (at?.key != null) return sameToken(at.key, key) ? scheme(at, req, res) : deny(res, 401, "not this launch's key");
      if (!signedIn(req)) {
        if (pathname === "/") return void res.writeHead(401, { ...HEADERS, "content-type": "text/html; charset=utf-8" }).end(SIGN_IN);
        return deny(res, 401, "sign in with the link the app shows");
      }
      return at ? scheme(at, req, res) : file(pathname, res);
    })().catch((e: unknown) => {
      opts.onError(`request: ${(e as Error).message}`);
      if (!res.headersSent) deny(res, 500, "failed");
    });
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://host");
    if (pathname !== SOCKET_PATH || !hostAllowed(req.headers.host, opts.names) || !sameOrigin(req.headers.origin, req.headers.host) || !signedIn(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => connected(ws));
  });

  function connected(ws: WebSocket): void {
    let tab: SocketTab | null = null;
    let served = new Set<string>();
    const late = setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, "no token"), 5000);
    ws.once("close", () => clearTimeout(late));
    const answer = (id: number, run: () => unknown): void => {
      void (async () => {
        let reply: MainFrame;
        try {
          reply = { t: "result", id, value: await run() };
        } catch (e) {
          reply = { t: "result", id, error: (e as Error)?.message ?? String(e) };
        }
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(json(reply));
        } catch (e) {
          ws.send(json({ t: "result", id, error: (e as Error).message }));
        }
      })();
    };
    ws.on("message", (data) => {
      let frame: TabFrame;
      try {
        frame = JSON.parse(String(data)) as TabFrame;
      } catch {
        return;
      }
      if (!tab) {
        if (frame.t !== "auth" || typeof frame.token !== "string" || !sameToken(frame.token, opts.token)) {
          ws.close(CLOSE_UNAUTHORIZED, "not this launch's token");
          return;
        }
        clearTimeout(late);
        tab = new SocketTab(ws, opts.onError);
        served = new Set(opts.channels.served());
        ws.send(json({ t: "hello", channels: [...served], platform: opts.platform, viewsKey: key }));
        opts.onTab(tab);
        return;
      }
      const from = tab;
      const args = Array.isArray((frame as { args?: unknown }).args) ? (frame as { args: unknown[] }).args : [];
      if (frame.t === "invoke" && typeof frame.id === "number") {
        const { ch } = frame;
        answer(frame.id, () => {
          if (!served.has(ch)) throw new Error(`${ch} is answered only in the app`);
          return opts.channels.invoke(ch, from, args);
        });
      } else if (frame.t === "send" && served.has(frame.ch)) {
        try {
          opts.channels.send(frame.ch, from, args);
        } catch (e) {
          opts.onError(`${frame.ch}: ${(e as Error).message}`);
        }
      }
    });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", (e) => opts.onError(e.message));
      port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () => new Promise<void>((done) => {
          for (const ws of sockets.clients) ws.terminate();
          sockets.close();
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}
