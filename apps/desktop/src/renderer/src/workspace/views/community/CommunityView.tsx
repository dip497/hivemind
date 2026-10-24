/**
 * CommunityView — the host side of an isolated community view: a sandboxed
 * iframe (its own `hm-view://<id>` origin, no `allow-same-origin`, strict CSP
 * stamped by main/view-packages.ts, no preload → no `window.hive`, no node),
 * one MessagePort to it (the plugin link every plugin's `hm` client talks to,
 * `../../plugin-link`), and the slots the plugin punches holes for (`surface-slots`).
 *
 * Misbehaviour (malformed traffic, floods, a runaway render loop attributed to
 * its iframe) disables it for the session; the registry then resolves the
 * active view to the fallback (canvas) with the sessions intact.
 */
import { isRemote } from "@hivemind/core/remote-uri";
import { useChromeState } from "../../chrome-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PORT_HANDSHAKE, type SurfaceRect, type LineRect, type ViewPermission } from "@hivemind/view-sdk/protocol";
import { viewSettingFields } from "@hivemind/view-sdk/manifest";
import type { CommunityLink } from "@hivemind/view-host/link";
import type { ViewPackageInfo } from "../../../../../shared/ipc";
import type { WorkspaceViewProps } from "../../workspace-view";
import { usePluginLink } from "../../plugin-link";
import { LayersPanel } from "../../../LayersPanel";
import { disableCommunityView } from "./registry";
import { edgeBandClip } from "./edge-band";
import { RemoteCommunityView } from "./RemoteCommunityView";
import { SurfaceSlots } from "./surface-slots";
import { LineSlots } from "./line-slots";
import { Loading } from "../../../components/ui/loading";

/** The host for one package. Rendered through the lazy wrapper in registry.ts
 *  (`pkg` is fixed per registered view; the props are the view contract). */
export function CommunityViewHost({ pkg, model, commands }: WorkspaceViewProps & { pkg: ViewPackageInfo }) {
  if (pkg.source === "host") return <RemoteCommunityView pkg={pkg} model={model} commands={commands} />;
  const manifest = pkg.manifest!;
  const url = window.hive.resourceUrl(pkg.url!);
  const capabilities = useMemo(() => manifest.permissions as ViewPermission[], [manifest]);
  return <CommunityView pkg={pkg} url={url} manifest={manifest} capabilities={capabilities} model={model} commands={commands} />;
}

function CommunityView({ pkg, url, manifest, capabilities, model, commands }: WorkspaceViewProps & { pkg: ViewPackageInfo; url: string; manifest: NonNullable<ViewPackageInfo["manifest"]>; capabilities: ViewPermission[] }) {
  {
    const rootRef = useRef<HTMLDivElement>(null);
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [rects, setRects] = useState<SurfaceRect[]>([]);
    const [lines, setLines] = useState<LineRect[]>([]);
    // One array per manifest: the link's settings memo keys on it.
    const fields = useMemo(() => viewSettingFields(manifest), [manifest]);
    const { link, ready, send, dialogs } = usePluginLink({
      pluginId: pkg.id, record: { kind: "view", id: pkg.id }, name: manifest.name, capabilities,
      fields, tokens: manifest.tokens, layoutId: pkg.id, personal: manifest.layout === "personal", props: { model, commands }, root: rootRef,
      onSurfaceRects: setRects, onLineRects: setLines, commands: manifest.commands, instance: { id: pkg.id, label: manifest.name },
      onDisable: (reason) => {
        toast.error(`The ${manifest.name} view was disabled: ${reason}. Switched back to Canvas — your tiles are untouched.`);
        disableCommunityView(pkg.id, reason);
      },
    });
    const linkRef = useRef<CommunityLink>(link);
    linkRef.current = link;
    const nameOf = useMemo(() => new Map(model.layerTiles.map((t) => [t.id, t.name])), [model.layerTiles]);
    const box = () => {
      const r = rootRef.current?.getBoundingClientRect();
      return { w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0) };
    };

    const onLoad = useCallback(() => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      const ch = new MessageChannel();
      link.attach(ch.port1);
      // The frame's origin is opaque (sandbox without allow-same-origin), so
      // the only valid target is "*"; nothing but the port travels with it.
      win.postMessage({ type: PORT_HANDSHAKE }, "*", [ch.port2]);
    }, [link]);

    // ── runaway watchdog: long tasks attributed to THIS iframe ──────────────
    useEffect(() => {
      if (typeof PerformanceObserver === "undefined") return;
      const name = `hm-view:${pkg.id}`;
      let po: PerformanceObserver | null = null;
      try {
        po = new PerformanceObserver((list) => {
          for (const e of list.getEntries() as PerformanceEntry[]) {
            const attr = (e as PerformanceEntry & { attribution?: Array<{ containerType?: string; containerName?: string; containerSrc?: string }> }).attribution ?? [];
            if (attr.some((a) => a.containerType === "iframe" && (a.containerName === name || a.containerSrc === url))) linkRef.current?.noteLongTask(e.duration);
          }
        });
        po.observe({ type: "longtask", buffered: false });
      } catch { po = null; }
      return () => po?.disconnect();
    }, []);

    // Undock from the host's bar (or Shift+Esc): release the tile NOW — the
    // surface parks whether or not the plugin cooperates — and tell the plugin.
    const undock = useCallback((tileId: string) => {
      setRects((rs) => rs.filter((r) => r.tileId !== tileId));
      send({ type: "undock", tileId });
    }, [send]);

    // Test seam (same spirit as the World view's `__world`).
    useEffect(() => {
      const el = rootRef.current as (HTMLDivElement & { __community?: CommunityLink }) | null;
      if (el) el.__community = link;
      return () => { if (el) delete el.__community; };
    }, [link]);

    // The compositor lesson from the World view: a DOM terminal repainting
    // above a full-window GPU layer made every repaint a blend of both. When
    // the plugin's surfaces form one band along an edge (a side/top/bottom
    // dock — the common case) the iframe is clipped with a rectangular
    // `inset()` so the two layers never overlap; a rect clip is free, unlike a
    // polygon mask. Floating rects stay plain overlays.
    const hostBox = useMemo(() => box(), [rects, lines]); // eslint-disable-line react-hooks/exhaustive-deps
    const { bottomInset } = useChromeState();
    const clip = useMemo(() => edgeBandClip(rects, hostBox), [rects, hostBox]);

    return (
      <div className="flex-1 min-h-0 flex flex-row">
      {/* The app's own Layers rail, every frame action with it, for a view that asks for it. */}
      {manifest.layers && (
        <LayersPanel
          frames={model.layerFrames}
          tiles={model.layerTiles}
          selectedTileId={model.selectedTileId}
          layoutKey={model.layoutKey}
          folder={model.repoPath && !isRemote(model.repoPath) ? model.repoPath : null}
          onResume={(agent, frameId, session) => { commands.spawnAgent(agent, frameId, { resume: session }); }}
          onFocusTile={commands.selectTile}
          onFocusFrame={(id) => { commands.selectFrame(id); commands.selectTile(null); commands.focusTile(id); }}
          frameActions={model.frameActions}
          sleepActions={model.sleepActions}
          tileActions={{ onClose: commands.closeTile, onRename: commands.renameTile }}
        />
      )}
      {/* Above the host's bottom island, so it never covers a docked tile's last lines. */}
      <div ref={rootRef} className="relative flex-1 min-h-0 overflow-hidden" style={{ marginBottom: bottomInset }} data-community-view={pkg.id} data-community-ready={ready ? "1" : "0"}>
        <iframe
          ref={iframeRef}
          name={`hm-view:${pkg.id}`}
          title={manifest.name}
          src={url}
          // Forms fire their submit event; the view's CSP (form-action 'none') sends them nowhere.
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          onLoad={onLoad}
          className="absolute inset-0 h-full w-full border-0 bg-transparent"
          style={clip ? { clipPath: clip } : undefined}
          data-community-clip={clip ?? undefined}
        />
        <SurfaceSlots rects={rects} width={hostBox.w} names={nameOf} commands={commands} onUndock={undock} />
        <LineSlots rects={lines} box={hostBox} />
        {dialogs}
        {!ready && <Loading className="pointer-events-none absolute inset-0" label={`Loading ${manifest.name}`} />}
      </div>
      </div>
    );
  }
}
