/**
 * The port agents drive browser tiles through (the hive-browser skill, `agent-browser --cdp`):
 * Chromium's DevTools port, passed through, with three differences. Each connection sees only the
 * Browser tiles it may reach (and the frames inside them): never the app's own windows, nor a
 * person's page in another frame, nor the cookies of a site it has no tile on. What is the person's
 * across the whole browser (closing it, a site's permissions) is refused. And keyboard input for a
 * tile's page is given to that page (page-keys.ts): on Chromium's own port it would go to whatever
 * holds focus in the app window.
 */
import http from "node:http";
import type { Duplex } from "node:stream";
import type { WebContents } from "electron";
import { WebSocket, WebSocketServer } from "ws";
import { keyboardCommand } from "./page-keys.js";

const KEYBOARD = new Set(["Input.insertText", "Input.dispatchKeyEvent"]);
/** Commands that name a target an agent may only name when it is a tile's page. */
const NAMING = new Set(["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget"]);
/** Commands on the whole browser, which the person shares with every agent. */
const REFUSED = new Set([
  "Browser.close", "Browser.crash", "Browser.crashGpuProcess", "Browser.grantPermissions", "Browser.setPermission", "Browser.resetPermissions",
  "Storage.clearCookies", "Network.clearBrowserCookies", "Target.disposeBrowserContext",
]);
/** Commands whose answer lists cookies. */
const COOKIE_READS = new Set(["Storage.getCookies", "Network.getAllCookies", "Network.getCookies"]);
/** Commands that change a site's cookies or data, and where each says which site. */
const COOKIE_WRITES = new Set(["Network.setCookie", "Network.setCookies", "Storage.setCookies", "Network.deleteCookies", "Storage.clearDataForOrigin"]);
const WORTH_READING = /"(?:Input|Target|Browser|Storage|Network)\./;
/** Commands that change what the person sees: the page says who is driving it while they come. */
const ACTS = /"(?:Input\.|Page\.navigate"|Page\.reload")/;
/** Ids the relay asks Chromium with itself; their answers are its own. */
const OWN_IDS = 2_000_000_000;

interface TargetInfo { targetId?: string }
interface Cookie { domain?: string; url?: string }
interface Message {
  id?: number;
  method?: string;
  params?: { targetId?: string; sessionId?: string; targetInfo?: TargetInfo; waitingForDebugger?: boolean } & Record<string, unknown>;
  sessionId?: string;
  result?: { sessionId?: string; targetInfos?: TargetInfo[]; cookies?: Cookie[] };
}

const hostOf = (url: string): string | null => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };
/** Whether a cookie for `domain` is one a page on one of `hosts` is sent. */
const coversHost = (domain: string, hosts: Set<string>): boolean => {
  const d = domain.replace(/^\./, "").toLowerCase();
  return [...hosts].some((host) => host === d || host.endsWith(`.${d}`));
};
/** The sites a cookie or data command changes. */
function sitesNamed(m: Message): string[] {
  const p = m.params ?? {};
  if (typeof p.origin === "string") return [hostOf(p.origin) ?? p.origin];
  const cookies = (Array.isArray(p.cookies) ? p.cookies : [p]) as Cookie[];
  return cookies.map((c) => c.domain ?? hostOf(c.url ?? "") ?? "");
}

/** Whether this connection may see and drive the page `targetId`. */
type IsPage = (targetId: string) => Promise<boolean>;

/** What the app tells the port about its Browser tiles. */
export interface BrowserPages {
  /** The Browser tile's page that is DevTools target `targetId`, if one is. */
  pageOf(targetId: string): Promise<WebContents | null>;
  /** The agent tile a connection is for, when its key is that tile's; else null. */
  agentOf(tile: string | null, key: string | null): string | null;
  /** Whether `agent` (null: a connection that names none) may see and drive the page `targetId`. */
  reaches(agent: string | null, targetId: string): Promise<boolean>;
  /** The hosts of the pages `agent` reaches, whose cookies it may read. */
  hostsOf(agent: string | null): Promise<Set<string>>;
  /** Whether the page `targetId` is in the same frame as the agent of `agentTile`: listed first. */
  near(agentTile: string, targetId: string): boolean;
  /** Open a Browser tile beside the agent of `agentTile`, showing `url`: its page's target. */
  open(agentTile: string, url: string): Promise<string>;
  /** `agent` has just changed what the page `targetId` shows. */
  acted(agent: string | null, targetId: string): void;
}

export interface BrowserPort {
  server: http.Server;
  /** Who may reach what has changed: end each connection holding a page it no longer reaches. */
  recheck(): Promise<void>;
  /** A person or a saved sign-in is signing in on page `targetId`. Until `release`, what agents ask
   *  of it waits, and they see no request's body; for a while after, nor these `secrets` anywhere. */
  guard(targetId: string, secrets: string[]): { release(): void };
}

/** How long a password stays hidden from agents after its sign-in: a page or a late event can repeat it. */
const HIDDEN_FOR_MS = 60_000;
const HIDDEN_TEXT = "••••••";
interface Guard { held: boolean; released: Promise<void>; secrets: string[] }

/** Serve on 127.0.0.1:`port` the DevTools port Chromium listens on at `chromium`. A connection
 *  says which agent tile it is for with `?tile=` and that tile's `key=` (its `AGENT_BROWSER_CDP`). */
export function serveBrowserPort(port: number, chromium: number, pages: BrowserPages): Promise<BrowserPort> {
  const theirs = `127.0.0.1:${chromium}`;
  const ours = `127.0.0.1:${port}`;
  const agentIn = (url: string): string | null => {
    const q = new URL(url, "http://port").searchParams;
    return pages.agentOf(q.get("tile"), q.get("key"));
  };
  const connections = new Set<Connection>();
  const guards = new Map<string, Guard>();
  // As Chromium's own port: only a loopback name, so a web page cannot reach it by renaming itself.
  const local = (host: string | undefined) => host === ours || host === `localhost:${port}`;
  const rename = (body: string) => body.split(theirs).join(ours).split(`localhost:${chromium}`).join(ours);

  const server = http.createServer((req, res) => {
    if (!local(req.headers.host)) { res.writeHead(403); res.end(); return; }
    const url = req.url ?? "/";
    // A page an agent opens on its own would be a window of the app, not a tile.
    if (url.startsWith("/json/new")) { res.writeHead(403); res.end("Open a Browser tile in Hivemind instead"); return; }
    const agent = agentIn(url);
    const isPage: IsPage = (id) => pages.reaches(agent, id);
    // Sockets this answer names are for the same agent.
    const search = url.includes("?") ? url.slice(url.indexOf("?")) : "";
    const named = /^\/json\/(?:close|activate)\/([^/?]+)/.exec(url)?.[1];
    const up = () => http.request({ host: "127.0.0.1", port: chromium, path: url, method: req.method, headers: { host: theirs } }, (r) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => void (async () => {
        let body = rename(Buffer.concat(chunks).toString("utf8"));
        if (search) body = body.split(new RegExp(`(ws://${ours}[^"]*)`)).map((part, i) => (i % 2 ? part + search : part)).join("");
        if (/^\/json(\/list)?\/?(\?|$)/.test(url)) {
          try {
            const list = JSON.parse(body) as { id: string }[];
            const kept = await Promise.all(list.map(async (t) => ((await isPage(t.id)) ? t : null)));
            body = JSON.stringify(kept.filter(Boolean), null, 2);
          } catch { /* not a list: as it came */ }
        }
        res.writeHead(r.statusCode ?? 502, { "content-type": r.headers["content-type"] ?? "application/json; charset=UTF-8" });
        res.end(body);
      })());
    });
    void (async () => {
      if (named && !(await isPage(named))) { res.writeHead(404); res.end("No such target id"); return; }
      const sent = up();
      sent.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(sent);
    })();
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // A web page always says where it comes from; the tools agents run never do. Chromium refuses it too.
    if (!local(req.headers.host) || req.headers.origin) { socket.destroy(); return; }
    const path = req.url ?? "/";
    const page = /^\/devtools\/page\/([^/?]+)/.exec(path)?.[1];
    const agent = agentIn(path);
    void (async () => {
      if (page && !(await pages.reaches(agent, page))) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (client) => relay(client, `ws://${theirs}${path.split("?")[0]}`, page, pages, agent, connections, guards));
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        server,
        recheck: async () => {
          await Promise.all([...connections].map(async (c) => {
            const held = await Promise.all([...c.held].map((id) => pages.reaches(c.agent, id)));
            if (held.includes(false)) c.end();
          }));
        },
        guard: (targetId, secrets) => {
          let open = () => {};
          const guard: Guard = { held: true, released: new Promise((r) => { open = r; }), secrets };
          guards.set(targetId, guard);
          return {
            release: () => {
              guard.held = false;
              open();
              const forget = () => { if (guards.get(targetId) === guard) guards.delete(targetId); };
              if (secrets.length) setTimeout(forget, HIDDEN_FOR_MS).unref?.();
              else forget();
            },
          };
        },
      });
    });
  });
}

/** A live connection: whose it is, and the pages it holds a session on. */
interface Connection { agent: string | null; held: Set<string>; end(): void }

/** One agent's connection, passed to Chromium's, but for keyboard input to a tile's page and for
 *  what is not a tile's page, which it neither sees nor reaches. `own`: the page a connection to
 *  one page is to. */
function relay(client: WebSocket, to: string, own: string | undefined, pages: BrowserPages, agent: string | null, connections: Set<Connection>, guards: Map<string, Guard>): void {
  const pageOf = (id: string) => pages.pageOf(id);
  const isPage: IsPage = (id) => pages.reaches(agent, id);
  const upstream = new WebSocket(to, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  /** Sessions the agent holds, and the target each is attached to. */
  const sessions = new Map<string, string>();
  /** Sessions Chromium attached to a target the agent does not see. */
  const hidden = new Set<string>();
  /** Targets the agent has been told of, so it hears when they go. */
  const told = new Set<string>();
  const attaching = new Map<number, string>();
  const listing = new Set<number>();
  const readingCookies = new Set<number>();
  /** Requests made during a sign-in, whose bodies an agent may not ask for. */
  const bodiless = new Set<string>();
  const guardOf = (sessionId: string | undefined) => {
    const target = sessionId ? sessions.get(sessionId) : own;
    return target ? guards.get(target) : undefined;
  };
  /** What Chromium said, as an agent may read it while a sign-in is guarded. */
  const guarded = (said: string): string => {
    let text = said;
    for (const guard of guards.values()) for (const secret of guard.secrets) if (text.includes(secret)) text = text.split(secret).join(HIDDEN_TEXT);
    if (!text.includes('"Network.requestWillBeSent"') && !text.includes('"Fetch.requestPaused"')) return text;
    const m = JSON.parse(text) as { sessionId?: string; params?: { requestId?: string; networkId?: string; request?: { postData?: unknown; postDataEntries?: unknown; hasPostData?: boolean } } };
    const request = m.params?.request;
    if (!request || !guardOf(m.sessionId)?.held) return text;
    for (const id of [m.params?.requestId, m.params?.networkId]) if (id) bodiless.add(id);
    delete request.postData;
    delete request.postDataEntries;
    delete request.hasPostData;
    return JSON.stringify(m);
  };
  let ownId = OWN_IDS;
  let ownPending = 0;
  const ask = (m: Record<string, unknown>) => { ownPending++; upstream.send(JSON.stringify({ id: ownId++, ...m })); };
  const waiting: string[] = [];
  const toChromium = (text: string) => (upstream.readyState === WebSocket.OPEN ? upstream.send(text) : waiting.push(text));
  const toAgent = (m: unknown) => { if (client.readyState === WebSocket.OPEN) client.send(typeof m === "string" ? m : JSON.stringify(m)); };
  const answer = (m: Message, body: Record<string, unknown>) => toAgent({ id: m.id, ...body, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
  const notFound = (m: Message) => answer(m, { error: { code: -32602, message: "No target with given id found" } });
  const self: Connection = { agent, held: new Set(own ? [own] : []), end: () => { connections.delete(self); client.terminate(); upstream.terminate(); } };
  connections.add(self);
  const end = () => self.end();
  const refuse = (m: Message, message: string) => answer(m, { error: { code: -32000, message } });

  const keyboard = async (m: Message): Promise<boolean> => {
    const target = m.sessionId ? sessions.get(m.sessionId) : own;
    const page = target ? await pageOf(target) : null;
    if (!page || page.isDestroyed()) return false;
    try {
      await keyboardCommand(page, m.method!, m.params ?? {});
      answer(m, { result: {} });
    } catch (e) {
      answer(m, { error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
    }
    return true;
  };

  /** Whether the agent sees what a message from Chromium is about. A target inside a session the
   *  agent holds (a frame of a tile's page) is shown; one at the top, only when it is a tile's page. */
  const shown = async (m: Message): Promise<boolean> => {
    if (m.sessionId && hidden.has(m.sessionId)) return false;
    const target = m.params?.targetInfo?.targetId ?? m.params?.targetId;
    if (!m.method?.startsWith("Target.") || !target) return true;
    if (m.method === "Target.targetDestroyed" || m.method === "Target.detachedFromTarget") return told.has(target) || (m.params?.sessionId ? sessions.has(m.params.sessionId) : false);
    const ok = (m.sessionId && sessions.has(m.sessionId)) || (await isPage(target));
    if (ok) told.add(target);
    return ok;
  };

  // In order, both ways: a read sent after a key must not overtake it, nor an event its target's.
  let fromAgent = Promise.resolve();
  client.on("message", (data) => {
    const text = data.toString();
    fromAgent = fromAgent.then(async () => {
      if (guards.size) {
        // A page's own requests wait on an interception's answer: it never waits here.
        const guard = guardOf(/"sessionId":"([^"]+)"/.exec(text)?.[1]);
        if (guard?.held && !text.includes('"Fetch.')) await guard.released;
      }
      if (bodiless.size && text.includes('"Network.getRequestPostData"')) {
        const m = JSON.parse(text) as Message;
        if (bodiless.has(String(m.params?.requestId))) { refuse(m, "This request belongs to a sign-in: its body is not an agent's to read"); return; }
      }
      if (ACTS.test(text)) {
        const session = /"sessionId":"([^"]+)"/.exec(text)?.[1];
        const target = session ? sessions.get(session) : own;
        if (target) pages.acted(agent, target);
      }
      if (WORTH_READING.test(text)) {
        let m: Message | null = null;
        try { m = JSON.parse(text) as Message; } catch { /* not ours to read */ }
        if (m?.method && REFUSED.has(m.method)) { refuse(m, "Hivemind's browser is shared with the person: this is theirs to do"); return; }
        if (m?.method && COOKIE_READS.has(m.method) && typeof m.id === "number") readingCookies.add(m.id);
        if (m?.method && COOKIE_WRITES.has(m.method)) {
          const hosts = await pages.hostsOf(agent);
          if (!sitesNamed(m).every((site) => coversHost(site, hosts))) { refuse(m, "That site is not open in a Browser tile this agent can use"); return; }
        }
        if (m?.method && KEYBOARD.has(m.method) && (await keyboard(m))) return;
        if (m?.method === "Target.createTarget") {
          // A new tab is a Browser tile beside the agent asking, which the person sees.
          if (!agent) { refuse(m, "Hivemind shows pages in Browser tiles: ask the person to open one"); return; }
          try {
            answer(m, { result: { targetId: await pages.open(agent, String(m.params?.url ?? "about:blank") || "about:blank") } });
          } catch (e) {
            refuse(m, e instanceof Error ? e.message : String(e));
          }
          return;
        }
        if (m?.method && (NAMING.has(m.method) || (m.method === "Target.getTargetInfo" && m.params?.targetId))) {
          const target = String(m.params?.targetId ?? "");
          if (!(await isPage(target))) { notFound(m); return; }
          if (m.method === "Target.attachToTarget" && typeof m.id === "number") attaching.set(m.id, target);
        }
        if (m?.method === "Target.getTargets" && typeof m.id === "number") listing.add(m.id);
      }
      toChromium(text);
    });
  });

  upstream.on("open", () => { for (const text of waiting.splice(0)) upstream.send(text); });
  let fromChromium = Promise.resolve();
  upstream.on("message", (data) => {
    const said = data.toString();
    fromChromium = fromChromium.then(async () => {
      const text = guards.size ? guarded(said) : said;
      const mentionsHidden = hidden.size > 0 && [...hidden].some((s) => text.includes(s));
      if (!mentionsHidden && !text.includes('"Target.') && !listing.size && !attaching.size && !ownPending && !readingCookies.size) return toAgent(text);
      let m: Message;
      try { m = JSON.parse(text) as Message; } catch { return toAgent(text); }
      if (typeof m.id === "number" && m.id >= OWN_IDS) { ownPending--; return; }
      if (typeof m.id === "number" && readingCookies.delete(m.id) && m.result?.cookies) {
        const hosts = await pages.hostsOf(agent);
        return toAgent({ ...m, result: { ...m.result, cookies: m.result.cookies.filter((c) => coversHost(c.domain ?? "", hosts)) } });
      }
      if (typeof m.id === "number" && listing.delete(m.id) && m.result?.targetInfos) {
        const kept = (await Promise.all(m.result.targetInfos.map(async (t) => (t.targetId && (await isPage(t.targetId)) ? t : null)))).filter((t): t is TargetInfo => t !== null);
        // The agent's own frame's tiles first: a session that names no tab takes the first.
        if (agent) kept.sort((a, b) => Number(pages.near(agent, b.targetId!)) - Number(pages.near(agent, a.targetId!)));
        return toAgent({ ...m, result: { ...m.result, targetInfos: kept } });
      }
      if (typeof m.id === "number" && attaching.has(m.id)) {
        if (m.result?.sessionId) { sessions.set(m.result.sessionId, attaching.get(m.id)!); self.held.add(attaching.get(m.id)!); }
        attaching.delete(m.id);
      }
      if (m.method === "Target.attachedToTarget" && m.params?.sessionId) {
        if (!(await shown(m))) {
          // Attached on its own (auto-attach): let it run, and leave it.
          hidden.add(m.params.sessionId);
          if (m.params.waitingForDebugger) ask({ method: "Runtime.runIfWaitingForDebugger", sessionId: m.params.sessionId });
          ask({ method: "Target.detachFromTarget", params: { sessionId: m.params.sessionId }, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
          return;
        }
        sessions.set(m.params.sessionId, m.params.targetInfo?.targetId ?? "");
        if (!m.sessionId && m.params.targetInfo?.targetId) self.held.add(m.params.targetInfo.targetId);
        return toAgent(text);
      }
      if (m.method === "Target.detachedFromTarget" && m.params?.sessionId && hidden.delete(m.params.sessionId)) return;
      if (!(await shown(m))) return;
      if (m.method === "Target.detachedFromTarget" && m.params?.sessionId) sessions.delete(m.params.sessionId);
      toAgent(text);
    });
  });
  client.on("close", end);
  client.on("error", end);
  upstream.on("close", end);
  upstream.on("error", end);
}
