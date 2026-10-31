/**
 * The port agents drive browser tiles through (the hive-browser skill, `agent-browser --cdp`):
 * Chromium's DevTools port, passed through, with two differences. It shows only the Browser
 * tiles' pages (and the frames inside them), never the app's own windows, which an agent would
 * otherwise land on and drive. And what a tile's page cannot do through Chromium is done through
 * Electron: keyboard input, reloading and printing (page-commands.ts), and downloads
 * (page-downloads.ts).
 */
import http from "node:http";
import type { Duplex } from "node:stream";
import type { WebContents } from "electron";
import { WebSocket, WebSocketServer } from "ws";
import { PAGE_COMMANDS, closeDialogBox, pageCommand } from "./page-commands.js";
import type { PageDownloads } from "./page-downloads.js";

const SETS_DOWNLOADS = new Set(["Browser.setDownloadBehavior", "Page.setDownloadBehavior"]);
/** Whether a message may be a command the relay has its own answer to or view of. */
const MAY_CONCERN_RELAY = /"(?:Input\.|Target\.|Page\.reload"|Page\.printToPDF"|Page\.handleJavaScriptDialog"|Browser\.setDownloadBehavior"|Page\.setDownloadBehavior")/;
/** Commands that name a target an agent may only name when it is a tile's page. */
const NAMING = new Set(["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget"]);
/** Ids the relay asks Chromium with itself; their answers are its own. */
const OWN_IDS = 2_000_000_000;

interface TargetInfo { targetId?: string }
interface Message {
  id?: number;
  method?: string;
  params?: { targetId?: string; sessionId?: string; targetInfo?: TargetInfo; waitingForDebugger?: boolean } & Record<string, unknown>;
  sessionId?: string;
  result?: { sessionId?: string; targetInfos?: TargetInfo[] };
}

/** Whether `targetId` is a Browser tile's page. */
type IsPage = (targetId: string) => Promise<boolean>;

/** What the app tells the port about its Browser tiles. */
export interface BrowserPages {
  /** The Browser tile's page that is DevTools target `targetId`, if one is. */
  pageOf(targetId: string): Promise<WebContents | null>;
  /** Whether the page `targetId` is in the same frame as the agent of `agentTile`: listed first. */
  near(agentTile: string, targetId: string): boolean;
  /** Open a Browser tile beside the agent of `agentTile`, showing `url`: its page's target. */
  open(agentTile: string, url: string): Promise<string>;
  /** The DevTools target of `page`, once known. */
  targetOf(page: WebContents): string | undefined;
  downloads: PageDownloads;
}

/** Serve on 127.0.0.1:`port` the DevTools port Chromium listens on at `chromium`. A connection
 *  says which agent tile it is for with `?tile=` (the agent's `AGENT_BROWSER_CDP`). */
export function serveBrowserPort(port: number, chromium: number, pages: BrowserPages): Promise<http.Server> {
  const pageOf = (id: string) => pages.pageOf(id);
  const theirs = `127.0.0.1:${chromium}`;
  const ours = `127.0.0.1:${port}`;
  const isPage: IsPage = async (id) => (await pageOf(id)) !== null;
  // As Chromium's own port: only a loopback name, so a web page cannot reach it by renaming itself.
  const local = (host: string | undefined) => host === ours || host === `localhost:${port}`;
  const rename = (body: string) => body.split(theirs).join(ours).split(`localhost:${chromium}`).join(ours);

  const server = http.createServer((req, res) => {
    if (!local(req.headers.host)) { res.writeHead(403); res.end(); return; }
    const url = req.url ?? "/";
    // A page an agent opens on its own would be a window of the app, not a tile.
    if (url.startsWith("/json/new")) { res.writeHead(403); res.end("Open a Browser tile in Hivemind instead"); return; }
    const up = http.request({ host: "127.0.0.1", port: chromium, path: url, method: req.method, headers: { host: theirs } }, (r) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => void (async () => {
        let body = rename(Buffer.concat(chunks).toString("utf8"));
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
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // A web page always says where it comes from; the tools agents run never do. Chromium refuses it too.
    if (!local(req.headers.host) || req.headers.origin) { socket.destroy(); return; }
    const path = req.url ?? "/";
    const page = /^\/devtools\/page\/([^/?]+)/.exec(path)?.[1];
    const agent = new URL(path, "http://port").searchParams.get("tile");
    void (async () => {
      if (page && !(await isPage(page))) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (client) => relay(client, `ws://${theirs}${path.split("?")[0]}`, page, isPage, pages, agent));
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(server); });
  });
}

/** One agent's connection, passed to Chromium's, but for commands Electron does for a tile's page
 *  and for what is not a tile's page, which it neither sees nor reaches. `own`: the page a connection to
 *  one page is to. */
function relay(client: WebSocket, to: string, own: string | undefined, isPage: IsPage, pages: BrowserPages, agent: string | null): void {
  const pageOf = (id: string) => pages.pageOf(id);
  const upstream = new WebSocket(to, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  /** Sessions the agent holds, and the target each is attached to. */
  const sessions = new Map<string, string>();
  /** Sessions Chromium attached to a target the agent does not see. */
  const hidden = new Set<string>();
  /** Targets the agent has been told of, so it hears when they go. */
  const told = new Set<string>();
  const attaching = new Map<number, string>();
  const listing = new Set<number>();
  let ownId = OWN_IDS;
  let ownPending = 0;
  const ask = (m: Record<string, unknown>) => { ownPending++; upstream.send(JSON.stringify({ id: ownId++, ...m })); };
  const waiting: string[] = [];
  const toChromium = (text: string) => (upstream.readyState === WebSocket.OPEN ? upstream.send(text) : waiting.push(text));
  const toAgent = (m: unknown) => { if (client.readyState === WebSocket.OPEN) client.send(typeof m === "string" ? m : JSON.stringify(m)); };
  const answer = (m: Message, body: Record<string, unknown>) => toAgent({ id: m.id, ...body, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
  const notFound = (m: Message) => answer(m, { error: { code: -32602, message: "No target with given id found" } });
  const end = () => { client.terminate(); upstream.terminate(); };

  const downloads = pages.downloads.follow((page) => {
    const target = pages.targetOf(page);
    return !!target && (own === target || [...sessions.values()].includes(target));
  }, toAgent);

  const onPage = async (m: Message): Promise<boolean> => {
    const target = m.sessionId ? sessions.get(m.sessionId) : own;
    const page = target ? await pageOf(target) : null;
    if (!page || page.isDestroyed()) return false;
    try {
      answer(m, { result: await pageCommand(page, m.method!, m.params ?? {}) });
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
    downloads.heardFrom();
    fromAgent = fromAgent.then(async () => {
      if (MAY_CONCERN_RELAY.test(text)) {
        let m: Message | null = null;
        try { m = JSON.parse(text) as Message; } catch { /* not ours to read */ }
        if (m?.method && PAGE_COMMANDS.has(m.method) && (await onPage(m))) return;
        // Chromium would reload the window around a page: never pass it on.
        if (m?.method === "Page.reload") { notFound(m); return; }
        if (m?.method === "Page.handleJavaScriptDialog") {
          const target = m.sessionId ? sessions.get(m.sessionId) : own;
          const page = target ? await pageOf(target) : null;
          if (page && !page.isDestroyed()) closeDialogBox(page);
        }
        if (m?.method && SETS_DOWNLOADS.has(m.method)) {
          try {
            downloads.ask(m.params ?? {});
            answer(m, { result: {} });
          } catch (e) {
            answer(m, { error: { code: -32602, message: e instanceof Error ? e.message : String(e) } });
          }
          return;
        }
        if (m?.method === "Target.createTarget") {
          // A new tab is a Browser tile beside the agent asking, which the person sees.
          if (!agent) { answer(m, { error: { code: -32000, message: "Hivemind shows pages in Browser tiles: ask the person to open one" } }); return; }
          try {
            answer(m, { result: { targetId: await pages.open(agent, String(m.params?.url ?? "about:blank") || "about:blank") } });
          } catch (e) {
            answer(m, { error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
          }
          return;
        }
        if (m?.method && NAMING.has(m.method)) {
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
    const text = data.toString();
    // Chromium names a download by an id Electron does not give: page-downloads.ts tells the agent.
    if (text.startsWith('{"method":"Page.download')) return;
    fromChromium = fromChromium.then(async () => {
      const mentionsHidden = hidden.size > 0 && [...hidden].some((s) => text.includes(s));
      if (!mentionsHidden && !text.includes('"Target.') && !listing.size && !attaching.size && !ownPending) return toAgent(text);
      let m: Message;
      try { m = JSON.parse(text) as Message; } catch { return toAgent(text); }
      if (typeof m.id === "number" && m.id >= OWN_IDS) { ownPending--; return; }
      if (typeof m.id === "number" && listing.delete(m.id) && m.result?.targetInfos) {
        const kept = (await Promise.all(m.result.targetInfos.map(async (t) => (t.targetId && (await isPage(t.targetId)) ? t : null)))).filter((t): t is TargetInfo => t !== null);
        // The agent's own frame's tiles first: a session that names no tab takes the first.
        if (agent) kept.sort((a, b) => Number(pages.near(agent, b.targetId!)) - Number(pages.near(agent, a.targetId!)));
        return toAgent({ ...m, result: { ...m.result, targetInfos: kept } });
      }
      if (typeof m.id === "number" && attaching.has(m.id)) {
        if (m.result?.sessionId) sessions.set(m.result.sessionId, attaching.get(m.id)!);
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
        return toAgent(text);
      }
      if (m.method === "Target.detachedFromTarget" && m.params?.sessionId && hidden.delete(m.params.sessionId)) return;
      if (!(await shown(m))) return;
      if (m.method === "Target.detachedFromTarget" && m.params?.sessionId) sessions.delete(m.params.sessionId);
      toAgent(text);
    });
  });
  client.on("close", downloads.stop);
  client.on("close", end);
  client.on("error", end);
  upstream.on("close", end);
  upstream.on("error", end);
}
