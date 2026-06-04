import { useCallback, useEffect, useRef, useState } from "react";
import type { WebviewTag } from "electron";
import { ArrowLeft, ArrowRight, RotateCw, X as XIcon, Plus, Search, Wrench, Bot, GripVertical } from "lucide-react";

interface Props {
  tileId: string;
  /** Frame this tile lives in — reported to main so the `hive-browser` skill
   *  can scope "the browser in my frame". Null when loose on the canvas. */
  frameId?: string | null;
  /** Initial URL for the first tab. */
  url?: string;
  /** Tile selection — the wrapper's `tile-locked` class gates pointer-events
   *  when false so the wheel pans the canvas (matches TerminalTile). */
  selected?: boolean;
  onClose?: () => void;
}

interface TabMeta {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canBack: boolean;
  canFwd: boolean;
}

/** Normalize an omnibox entry: a bare host/URL → https://, else a Google search. */
function toUrl(input: string): string {
  const s = input.trim();
  if (!s) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^[^\s]+\.[^\s]+$/.test(s) && !s.includes(" ")) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

const DEFAULT_URL = "https://duckduckgo.com";

/** One tab = one out-of-process <webview> (own webContents). Hidden tabs stay
 *  alive (background-tab semantics). Reports nav/title/favicon/loading up; the
 *  parent toolbar drives the ACTIVE webview imperatively via the shared ref map. */
function TabView({
  tabId, initialUrl, active, onReady, onGone, onUpdate,
}: {
  tabId: string;
  initialUrl: string;
  active: boolean;
  onReady: (id: string, wv: WebviewTag) => void;
  onGone: (id: string) => void;
  onUpdate: (id: string, patch: Partial<TabMeta>) => void;
}) {
  const ref = useRef<WebviewTag | null>(null);
  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const sync = () => {
      try {
        onUpdate(tabId, { url: wv.getURL(), canBack: wv.canGoBack(), canFwd: wv.canGoForward() });
      } catch { /* guest not ready */ }
    };
    const onDom = () => { onReady(tabId, wv); sync(); };
    const onStart = () => onUpdate(tabId, { loading: true });
    const onStop = () => { onUpdate(tabId, { loading: false }); sync(); };
    const onNav = () => sync();
    const onTitle = (e: Electron.PageTitleUpdatedEvent) => onUpdate(tabId, { title: e.title || "New tab" });
    const onFav = (e: Electron.PageFaviconUpdatedEvent) => onUpdate(tabId, { favicon: e.favicons?.[0] });

    wv.addEventListener("dom-ready", onDom);
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    wv.addEventListener("did-navigate", onNav);
    wv.addEventListener("did-navigate-in-page", onNav);
    wv.addEventListener("page-title-updated", onTitle as EventListener);
    wv.addEventListener("page-favicon-updated", onFav as EventListener);
    return () => {
      wv.removeEventListener("dom-ready", onDom);
      wv.removeEventListener("did-start-loading", onStart);
      wv.removeEventListener("did-stop-loading", onStop);
      wv.removeEventListener("did-navigate", onNav);
      wv.removeEventListener("did-navigate-in-page", onNav);
      wv.removeEventListener("page-title-updated", onTitle as EventListener);
      wv.removeEventListener("page-favicon-updated", onFav as EventListener);
      onGone(tabId);
    };
  }, [tabId, onReady, onGone, onUpdate]);

  return (
    <webview
      ref={ref as React.RefObject<HTMLElement>}
      src={initialUrl}
      partition="persist:browser"
      className="w-full h-full"
      style={{ display: active ? "inline-flex" : "none", width: "100%", height: "100%" }}
    />
  );
}

export function BrowserTile({ tileId, frameId, url, selected, onClose }: Props) {
  const seq = useRef(1);
  const initialUrls = useRef<Record<string, string>>({ t0: url ?? DEFAULT_URL });
  const [tabs, setTabs] = useState<TabMeta[]>(() => [
    { id: "t0", url: url ?? DEFAULT_URL, title: "New tab", loading: false, canBack: false, canFwd: false },
  ]);
  const [activeId, setActiveId] = useState("t0");
  const [address, setAddress] = useState(url ?? DEFAULT_URL);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [zoom, setZoom] = useState(1);
  const [cdpMsg, setCdpMsg] = useState<string | null>(null);

  const wvMap = useRef(new Map<string, WebviewTag>());
  const activeIdRef = useRef(activeId);
  const addrFocused = useRef(false);
  activeIdRef.current = activeId;

  const active = tabs.find((t) => t.id === activeId);
  const activeWv = () => wvMap.current.get(activeId) ?? null;

  // Point the main-process CDP bridge at the ACTIVE tab's guest, so an agent
  // always drives the visible page. Re-registered on tab switch.
  const registerActive = useCallback(() => {
    const wv = wvMap.current.get(activeIdRef.current);
    if (!wv) return;
    let curUrl = "";
    try { curUrl = wv.getURL(); } catch { /* not ready */ }
    try { window.hive.browserRegister(tileId, wv.getWebContentsId(), frameId ?? null, curUrl); } catch { /* not ready */ }
  }, [tileId, frameId]);

  const onReady = useCallback((id: string, wv: WebviewTag) => {
    wvMap.current.set(id, wv);
    try { wv.setZoomFactor(zoom); } catch { /* ignore */ }
    if (id === activeIdRef.current) registerActive();
  }, [registerActive, zoom]);

  const onGone = useCallback((id: string) => { wvMap.current.delete(id); }, []);
  const onUpdate = useCallback((id: string, patch: Partial<TabMeta>) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // Keep the address bar mirroring the active tab unless the user is editing it,
  // and re-publish the active URL to main so the discovery file stays current.
  useEffect(() => {
    if (!addrFocused.current && active) setAddress(active.url);
    registerActive();
  }, [activeId, active?.url, active, registerActive]);

  // Re-register CDP + sync zoom on tab switch.
  useEffect(() => {
    registerActive();
    const wv = wvMap.current.get(activeId);
    try { wv?.setZoomFactor(zoom); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const newTab = useCallback((startUrl?: string) => {
    const id = `t${seq.current++}`;
    const u = startUrl ?? DEFAULT_URL;
    initialUrls.current[id] = u;
    setTabs((ts) => [...ts, { id, url: u, title: "New tab", loading: false, canBack: false, canFwd: false }]);
    setActiveId(id);
  }, []);
  const newTabRef = useRef(newTab);
  newTabRef.current = newTab;

  const closeTab = useCallback((id: string) => {
    setTabs((ts) => {
      if (ts.length <= 1) { onClose?.(); return ts; } // last tab → close the tile
      const idx = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (id === activeIdRef.current) {
        const pick = next[Math.max(0, idx - 1)] ?? next[0]!;
        setActiveId(pick.id);
      }
      delete initialUrls.current[id];
      return next;
    });
  }, [onClose]);

  // A guest's link/popup (target=_blank, window.open) arrives from main → if it
  // belongs to one of THIS tile's tabs, open it as a new tab.
  useEffect(() => {
    const off = window.hive.onBrowserPopup(({ fromId, url: popUrl }) => {
      for (const wv of wvMap.current.values()) {
        try { if (wv.getWebContentsId() === fromId) { newTabRef.current(popUrl); return; } } catch { /* ignore */ }
      }
    });
    return off;
  }, []);

  const go = (raw: string) => {
    const u = toUrl(raw);
    setAddress(u);
    onUpdate(activeId, { url: u });
    try { activeWv()?.loadURL(u); } catch { /* ignore */ }
  };

  const applyZoom = (z: number) => {
    const clamped = Math.min(3, Math.max(0.3, Math.round(z * 10) / 10));
    setZoom(clamped);
    try { activeWv()?.setZoomFactor(clamped); } catch { /* ignore */ }
  };

  const runFind = (text: string) => {
    setFindText(text);
    const wv = activeWv();
    if (!wv) return;
    if (text) wv.findInPage(text);
    else wv.stopFindInPage("clearSelection");
  };
  const closeFind = () => { setFindOpen(false); try { activeWv()?.stopFindInPage("clearSelection"); } catch { /* ignore */ } };

  const toggleDevtools = () => {
    const wv = activeWv();
    if (!wv) return;
    try { wv.isDevToolsOpened() ? wv.closeDevTools() : wv.openDevTools(); } catch { /* ignore */ }
  };

  // Visible proof CDP drives the VISIBLE tab: attach the debugger and run a tiny
  // script (read title → navigate via CDP). Same path an agent uses.
  const cdpSelfTest = async () => {
    setCdpMsg("running…");
    try {
      const t = await window.hive.browserCdp(tileId, "Runtime.evaluate", {
        expression: "document.title", returnByValue: true,
      }) as { result?: { value?: string } };
      const title = t?.result?.value ?? "(no title)";
      await window.hive.browserCdp(tileId, "Page.navigate", { url: "https://example.com" });
      setCdpMsg(`CDP ok · read "${title}" · navigated to example.com`);
    } catch (e) {
      setCdpMsg(`CDP failed: ${(e as Error).message}`);
    }
    setTimeout(() => setCdpMsg(null), 6000);
  };

  // Keyboard shortcuts — only fire when focus is in our chrome (the guest
  // renderer swallows keys when the page itself has focus; the toolbar buttons
  // cover that case).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "t") { e.preventDefault(); newTab(); }
    else if (k === "w") { e.preventDefault(); closeTab(activeId); }
    else if (k === "f") { e.preventDefault(); setFindOpen(true); }
    else if (k === "r") { e.preventDefault(); activeWv()?.reload(); }
    else if (k === "=" || k === "+") { e.preventDefault(); applyZoom(zoom + 0.1); }
    else if (k === "-") { e.preventDefault(); applyZoom(zoom - 0.1); }
    else if (k === "0") { e.preventDefault(); applyZoom(1); }
  };

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]" onKeyDown={onKeyDown}>
      {/* Tab strip (doubles as the drag handle). */}
      <div className="tile-drag-handle flex items-stretch gap-0.5 px-1.5 pt-1 bg-[var(--color-bg3)] border-b border-[var(--color-line)] cursor-grab active:cursor-grabbing">
        <GripVertical aria-hidden size={13} className="text-[var(--color-fg3)] self-center shrink-0 mr-0.5" />
        <div className="flex items-end gap-0.5 overflow-x-auto flex-1 min-w-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={`nodrag group flex items-center gap-1.5 px-2 py-1 rounded-t-md text-[11px] font-mono max-w-[160px] min-w-[90px] border-b-2 ${
                t.id === activeId
                  ? "bg-[var(--color-bg2)] text-[var(--color-fg)] border-[var(--color-brand)]"
                  : "bg-[var(--color-bg4)] text-[var(--color-fg3)] border-transparent hover:text-[var(--color-fg2)]"
              }`}
              title={t.title}
            >
              {t.loading ? (
                <RotateCw size={11} className="animate-spin shrink-0 text-[var(--color-fg3)]" />
              ) : t.favicon ? (
                <img src={t.favicon} alt="" className="size-3.5 shrink-0 rounded-sm" />
              ) : (
                <span aria-hidden className="size-1.5 rounded-full shrink-0 bg-[var(--color-fg3)]" />
              )}
              <span className="truncate flex-1 text-left">{t.title || "New tab"}</span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                className="size-3.5 grid place-items-center rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--color-line2)] shrink-0"
                aria-label="close tab"
              >
                <XIcon size={10} />
              </span>
            </button>
          ))}
          <button
            onClick={() => newTab()}
            className="nodrag size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg2)] hover:text-[var(--color-fg)] shrink-0 self-center"
            aria-label="new tab"
            title="New tab (⌘T)"
          >
            <Plus size={14} />
          </button>
        </div>
        <button
          className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] self-center shrink-0"
          aria-label="close browser"
          onClick={() => onClose?.()}
          title="Close browser tile"
        >
          <XIcon size={13} />
        </button>
      </div>

      {/* Address + nav toolbar. */}
      <div className="h-8 flex items-center gap-1 px-2 bg-[var(--color-bg3)] border-b border-[var(--color-line)]">
        <button className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] enabled:hover:bg-[var(--color-line2)] enabled:hover:text-[var(--color-fg)] disabled:opacity-30" onClick={() => activeWv()?.goBack()} disabled={!active?.canBack} aria-label="back" title="Back"><ArrowLeft size={13} /></button>
        <button className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] enabled:hover:bg-[var(--color-line2)] enabled:hover:text-[var(--color-fg)] disabled:opacity-30" onClick={() => activeWv()?.goForward()} disabled={!active?.canFwd} aria-label="forward" title="Forward"><ArrowRight size={13} /></button>
        <button className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]" onClick={() => (active?.loading ? activeWv()?.stop() : activeWv()?.reload())} aria-label="reload" title="Reload (⌘R)"><RotateCw size={12} className={active?.loading ? "animate-spin" : ""} /></button>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={() => { addrFocused.current = true; }}
          onBlur={() => { addrFocused.current = false; if (active) setAddress(active.url); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { go(address); (e.target as HTMLInputElement).blur(); }
            if (e.key === "Escape") { (e.target as HTMLInputElement).blur(); }
          }}
          spellCheck={false}
          className="nodrag flex-1 min-w-0 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-0.5 text-[11px] font-mono text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)]"
          placeholder="Search or enter address"
          title={active?.title}
        />
        <button className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]" onClick={() => setFindOpen((v) => !v)} aria-label="find" title="Find in page (⌘F)"><Search size={12} /></button>
        <button className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]" onClick={toggleDevtools} aria-label="devtools" title="Toggle DevTools"><Wrench size={12} /></button>
        {/* Visible CDP proof — runs the same bridge an agent uses against the visible tab. */}
        <button className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]" onClick={cdpSelfTest} aria-label="cdp test" title="CDP self-test (drive this tab like an agent)"><Bot size={12} /></button>
      </div>

      {findOpen && (
        <div className="h-8 flex items-center gap-2 px-2 bg-[var(--color-bg4)] border-b border-[var(--color-line)]">
          <input
            autoFocus
            value={findText}
            onChange={(e) => runFind(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") activeWv()?.findInPage(findText, { findNext: true }); if (e.key === "Escape") closeFind(); }}
            placeholder="Find in page"
            className="nodrag flex-1 min-w-0 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-0.5 text-[11px] font-mono text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)]"
          />
          <button className="nodrag text-[11px] text-[var(--color-fg3)] hover:text-[var(--color-fg)]" onClick={closeFind}>Done</button>
        </div>
      )}

      {cdpMsg && (
        <div className="px-2 py-1 text-[10px] font-mono bg-[var(--color-bg4)] border-b border-[var(--color-line)] text-[var(--color-fg2)] truncate" title={cdpMsg}>
          🤖 {cdpMsg}
        </div>
      )}

      {/* Guests. All tabs mounted; only the active one is shown. */}
      <div className="flex-1 bg-white relative">
        {tabs.map((t) => (
          <div key={t.id} className="absolute inset-0" style={{ display: t.id === activeId ? "block" : "none" }}>
            <TabView
              tabId={t.id}
              initialUrl={initialUrls.current[t.id] ?? DEFAULT_URL}
              active={t.id === activeId}
              onReady={onReady}
              onGone={onGone}
              onUpdate={onUpdate}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
