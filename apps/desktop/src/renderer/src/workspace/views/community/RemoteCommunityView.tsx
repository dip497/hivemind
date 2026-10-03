/** A host-owned view in a guest window. Its files come through view.file into the same
 * sandboxed hm-view frame as an installed view; its protocol session runs on the host. */
import { useCallback, useEffect, useRef, useState } from "react";
import { PORT_HANDSHAKE, type HostMessage, type PluginMessage, type SurfaceRect } from "@hivemind/view-sdk/protocol";
import type { ViewScreen } from "@hivemind/workspace-api/views";
import type { ViewPackageInfo } from "../../../../../shared/ipc";
import type { WorkspaceViewProps } from "../../workspace-view";
import { TileSlot } from "../../tile-host";
import { SlotBar } from "../../slot-chrome";
import { readTheme } from "./CommunityView";

export function RemoteCommunityView({ pkg, model, commands }: WorkspaceViewProps & { pkg: ViewPackageInfo }) {
  const root = useRef<HTMLDivElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const session = useRef<string | null>(null);
  const pending = useRef<HostMessage[]>([]);
  const pendingPosts = useRef<PluginMessage[]>([]);
  const [rects, setRects] = useState<SurfaceRect[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repo = model.repoPath;
  const screen = useCallback((): ViewScreen => {
    const bounds = root.current?.getBoundingClientRect();
    return { w: Math.round(bounds?.width ?? 0), h: Math.round(bounds?.height ?? 0), theme: readTheme(),
      device: { touch: matchMedia("(pointer: coarse)").matches, compact: false } };
  }, []);
  const deliver = (message: HostMessage) => {
    if (port.current) port.current.postMessage(message);
    else pending.current.push(message);
  };

  useEffect(() => {
    if (!repo) return;
    let live = true;
    const offSaid = window.hive.onViewSaid((id, message) => { if (id === session.current) deliver(message); });
    const offRects = window.hive.onViewRects((id, next) => { if (id === session.current) setRects(next); });
    const offEnded = window.hive.onViewEnded((id, why) => { if (id === session.current) setError(why); });
    void window.hive.viewOpen(pkg.id, repo, screen()).then(({ session: id }) => {
      if (!live) { void window.hive.viewClose(id, repo); return; }
      session.current = id;
      for (const message of pendingPosts.current.splice(0)) window.hive.viewPost(id, message, repo);
      setReady(true);
    }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    const observer = new ResizeObserver(() => { if (session.current) window.hive.viewScreen(session.current, screen(), repo); });
    if (root.current) observer.observe(root.current);
    const theme = new MutationObserver(() => { if (session.current) window.hive.viewScreen(session.current, screen(), repo); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-preset", "style"] });
    return () => {
      live = false;
      offSaid(); offRects(); offEnded(); observer.disconnect(); theme.disconnect();
      if (session.current) void window.hive.viewClose(session.current, repo);
      session.current = null;
      port.current?.close(); port.current = null;
    };
  }, [pkg.id, repo, screen]);

  const onLoad = () => {
    const win = iframe.current?.contentWindow;
    if (!win) return;
    const channel = new MessageChannel();
    port.current?.close();
    port.current = channel.port1;
    channel.port1.onmessage = (event: MessageEvent<PluginMessage>) => {
      if (session.current && repo) window.hive.viewPost(session.current, event.data, repo);
      else pendingPosts.current.push(event.data);
    };
    for (const message of pending.current.splice(0)) channel.port1.postMessage(message);
    win.postMessage({ type: PORT_HANDSHAKE }, "*", [channel.port2]);
  };
  const nameOf = new Map(model.layerTiles.map((tile) => [tile.id, tile.name]));
  return <div ref={root} className="relative flex-1 min-h-0 overflow-hidden" data-community-view={pkg.id} data-community-ready={ready ? "1" : "0"}>
    {!error && <iframe ref={iframe} name={`hm-view:${pkg.id}`} title={pkg.manifest?.name ?? pkg.id} src={pkg.url ?? undefined}
      sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={onLoad} className="absolute inset-0 h-full w-full border-0 bg-transparent" />}
    <div className="pointer-events-none absolute inset-0" data-community-surfaces>
      {rects.map((r) => <div key={r.tileId} className="pointer-events-auto absolute flex flex-col overflow-hidden bg-[var(--color-bg)]"
        style={{ left: r.x, top: r.y, width: r.w, height: r.h }} data-community-slot={r.tileId}>
        {r.chrome !== "none" && <SlotBar tileId={r.tileId} name={nameOf.get(r.tileId) ?? r.tileId} commands={commands}
          onUndock={() => { setRects((old) => old.filter((item) => item.tileId !== r.tileId)); deliver({ type: "undock", tileId: r.tileId }); }} />}
        <TileSlot tileId={r.tileId} transient className="relative z-10 min-h-0 flex-1" />
      </div>)}
    </div>
    {error && <div role="alert" className="absolute inset-0 grid place-items-center text-[var(--color-fg2)]">{error}</div>}
    {!ready && !error && <div className="pointer-events-none absolute inset-0 grid place-items-center text-[var(--color-fg2)]">Loading {pkg.manifest?.name ?? pkg.id}…</div>}
  </div>;
}
