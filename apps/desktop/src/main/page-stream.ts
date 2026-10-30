/**
 * A browser tile's page, watched and used from where the app has no web view (a browser tab the app
 * serves): the page itself stays the one in the app window, the same one its agent drives. It is
 * sent as pictures, each when the page changes, and a viewer is sent the next only once it has
 * shown the last, so a slow link gets fewer pictures rather than a backlog. What the viewer does
 * comes back as the page's own input. A page whose window is minimized or hidden draws nothing,
 * so its viewers are told why the picture stopped.
 */
import { BrowserWindow, type WebContents } from "electron";
import { pressKey, typeText } from "./page-keys.js";
import { FRAME_EVENT, GONE_EVENT, SHOWN_EVENT, WATCHED_EVENT, type PageFrame, type PageInput } from "../shared/page-input.js";

/** Who watches: a window, or a tab of the browser server. */
export interface PageViewer {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): void;
}

interface Watch {
  guest: WebContents;
  viewers: Map<PageViewer, { busy: boolean; behind: boolean }>;
  latest: PageFrame | null;
  /** The page's viewport in CSS pixels, where input lands. */
  viewport: { width: number; height: number } | null;
  /** A picture is taken unless the screencast sends one first. */
  nudge: () => void;
  stop: () => void;
}

/** Whether the app window that holds `guest` draws: not minimized, not hidden. */
function windowOf(guest: WebContents): BrowserWindow | null {
  const host = guest.hostWebContents;
  return host ? BrowserWindow.fromWebContents(host) : null;
}
const drawn = (win: BrowserWindow | null) => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();

export class PageStreams {
  private readonly watches = new Map<string, Watch>();

  /** `pageOf` is the page a tile shows now (its active tab), or null. */
  constructor(private readonly pageOf: (tileId: string) => WebContents | null) {}

  /** `viewer` watches the tile's page: the last picture now, if there is one, then each new one. */
  async watch(tileId: string, viewer: PageViewer): Promise<{ shown: boolean }> {
    let w = this.watches.get(tileId);
    if (!w) {
      const guest = this.pageOf(tileId);
      if (!guest) throw new Error("this page is not open in the app window");
      w = await this.start(tileId, guest);
    }
    if (!w.viewers.has(viewer)) {
      w.viewers.set(viewer, { busy: false, behind: false });
      viewer.once("destroyed", () => this.unwatch(tileId, viewer));
    }
    if (w.latest) this.offer(tileId, w, viewer);
    else w.nudge();
    return { shown: drawn(windowOf(w.guest)) };
  }

  /** The tiles someone is watching. */
  watched(): string[] {
    return [...this.watches.keys()];
  }

  unwatch(tileId: string, viewer: PageViewer): void {
    const w = this.watches.get(tileId);
    if (!w || !w.viewers.delete(viewer) || w.viewers.size) return;
    w.stop();
    this.watches.delete(tileId);
  }

  /** The viewer has shown its last picture: it is sent the newest, if one came since. */
  shown(tileId: string, viewer: PageViewer): void {
    const w = this.watches.get(tileId);
    const v = w?.viewers.get(viewer);
    if (!w || !v) return;
    v.busy = false;
    if (v.behind) this.offer(tileId, w, viewer);
  }

  /** The tile shows another page (its tab changed), or none (it closed): its viewers watch that
   *  one, or are told the page is gone. */
  async moved(tileId: string): Promise<void> {
    const w = this.watches.get(tileId);
    const guest = this.pageOf(tileId);
    if (!w || guest === w.guest) return;
    w.stop();
    this.watches.delete(tileId);
    if (!guest) {
      for (const viewer of w.viewers.keys()) if (!viewer.isDestroyed()) viewer.send(GONE_EVENT, tileId);
      return;
    }
    const next = await this.start(tileId, guest);
    for (const viewer of w.viewers.keys()) next.viewers.set(viewer, { busy: false, behind: false });
  }

  /** What `viewer`, watching the tile, does on its page. */
  async input(tileId: string, viewer: PageViewer, input: PageInput): Promise<void> {
    const w = this.watches.get(tileId);
    if (!w || !w.viewers.has(viewer) || w.guest.isDestroyed()) throw new Error("this page is not being watched");
    w.nudge();
    const g = w.guest;
    const send = (method: string, params: Record<string, unknown>) => g.debugger.sendCommand(method, params);
    const at = async (x: number, y: number) => {
      w.viewport ??= await this.viewportOf(g);
      return { x: x * w.viewport.width, y: y * w.viewport.height };
    };
    switch (input.kind) {
      case "mouse":
        await send("Input.dispatchMouseEvent", { type: input.type, ...(await at(input.x, input.y)), button: input.button, clickCount: input.clickCount, modifiers: input.modifiers });
        return;
      case "wheel":
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...(await at(input.x, input.y)), deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers });
        return;
      case "key":
        pressKey(g, input);
        return;
      case "text":
        await typeText(g, input.text);
        return;
      case "go":
        if (input.to === "back") g.navigationHistory.goBack();
        else if (input.to === "forward") g.navigationHistory.goForward();
        else g.reload();
        return;
      case "open":
        await g.loadURL(input.url).catch(() => { /* the page says why */ });
        return;
    }
  }

  private async viewportOf(guest: WebContents): Promise<{ width: number; height: number }> {
    const m = (await guest.debugger.sendCommand("Page.getLayoutMetrics")) as { cssVisualViewport: { clientWidth: number; clientHeight: number } };
    return { width: m.cssVisualViewport.clientWidth, height: m.cssVisualViewport.clientHeight };
  }

  private offer(tileId: string, w: Watch, viewer: PageViewer): void {
    const v = w.viewers.get(viewer);
    if (!v || !w.latest) return;
    if (v.busy) { v.behind = true; return; }
    if (viewer.isDestroyed()) return;
    v.busy = true;
    v.behind = false;
    viewer.send(FRAME_EVENT, tileId, w.latest);
  }

  private async start(tileId: string, guest: WebContents): Promise<Watch> {
    if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
    const w: Watch = { guest, viewers: new Map(), latest: null, viewport: null, nudge: () => {}, stop: () => {} };
    let size = "";
    const show = (data: string) => {
      const history = guest.navigationHistory;
      w.latest = { data, url: guest.getURL(), title: guest.getTitle(), canBack: history.canGoBack(), canForward: history.canGoForward() };
      for (const viewer of w.viewers.keys()) this.offer(tileId, w, viewer);
    };
    // A page out of the app window's view is not drawn, so it sends no screencast; a screenshot draws it.
    let frames = 0;
    let waiting: ReturnType<typeof setTimeout> | undefined;
    w.nudge = () => {
      if (waiting) return;
      const seen = frames;
      waiting = setTimeout(() => {
        waiting = undefined;
        if (frames !== seen || guest.isDestroyed() || !guest.debugger.isAttached()) return;
        void guest.debugger.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: 50 })
          .then((r: { data: string }) => { if (frames === seen) show(r.data); }, () => {});
      }, 250);
    };
    const onMessage = (_e: unknown, method: string, params: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      if (method !== "Page.screencastFrame") return;
      void guest.debugger.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      const now = `${params.metadata.deviceWidth}x${params.metadata.deviceHeight}`;
      if (now !== size) { size = now; w.viewport = null; }
      frames++;
      show(params.data);
    };
    const win = windowOf(guest);
    const tell = () => { for (const viewer of w.viewers.keys()) if (!viewer.isDestroyed()) viewer.send(SHOWN_EVENT, tileId, drawn(win)); };
    const states = ["minimize", "restore", "hide", "show"] as const;
    guest.debugger.on("message", onMessage);
    guest.on("did-stop-loading", w.nudge);
    for (const s of states) win?.on(s as "show", tell);
    // The app window keeps the page drawn while it is watched, even scrolled out of its view.
    const told = (watched: boolean) => { if (!guest.isDestroyed()) guest.hostWebContents?.send(WATCHED_EVENT, tileId, watched); };
    told(true);
    w.stop = () => {
      told(false);
      clearTimeout(waiting);
      guest.debugger.off("message", onMessage);
      guest.off("did-stop-loading", w.nudge);
      for (const s of states) win?.off(s as "show", tell);
      if (!guest.isDestroyed() && guest.debugger.isAttached()) void guest.debugger.sendCommand("Page.stopScreencast").catch(() => {});
    };
    this.watches.set(tileId, w);
    await guest.debugger.sendCommand("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 1600, maxHeight: 1600 });
    return w;
  }
}
