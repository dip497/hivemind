/**
 * CommunityView — the host side of an isolated community view: a sandboxed
 * iframe (its own `hm-view://<id>` origin, no `allow-same-origin`, strict CSP
 * stamped by main/view-packages.ts, no preload → no `window.hive`, no node),
 * one MessagePort to it (host-link.ts), and an overlay of real `<TileSlot>`s
 * positioned wherever the plugin punches a hole (`surfaceRects`).
 *
 * The plugin never receives the model: it gets a projection — frames + tiles +
 * membership with colours pre-resolved to hex (`structure`), names on their
 * own (`names`), selection with a "fresh since mount" flag, per-tile status on
 * subscription — and everything it sends back is validated before it touches
 * a command. Misbehaviour (malformed traffic, floods, a runaway render loop
 * attributed to its iframe) disables it for the session; the registry then
 * resolves the active view to the fallback (canvas) with the sessions intact.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PORT_HANDSHAKE, PROTOCOL_VERSION, STATUS_TONES, type HostMessage, type SurfaceRect, type ViewFrameMachine, type ViewPermission, type ViewTheme } from "@hivemind/view-sdk/protocol";
import { hostIdOfUri, machineByHost, statusOf, useMachines } from "../../../machines/store";
import type { ViewPackageInfo } from "../../../../../shared/ipc";
import type { WorkspaceViewProps } from "../../workspace-view";
import { TileSlot } from "../../tile-host";
import { SlotBar } from "../../slot-chrome";
import { Wallpaper } from "../../../Wallpaper";
import { ACCENTS, effectiveGlass, getTheme, useSurfacePolicy } from "../../../theme-store";
import { loadViewLayout, saveViewLayout, type ViewLayoutSpec } from "../../view-layout-store";
import { cssColorToHexString } from "../../css-color";
import { CommunityLink } from "./host-link";
import { disableCommunityView } from "./registry";
import { edgeBandClip } from "./edge-band";

const THEME_VARS = ["bg", "bg2", "bg3", "bg4", "fg", "fg2", "fg3", "line", "line2", "brand", "err", "ok", "warn", "info", "accent"];

function readTheme(): ViewTheme {
  const cs = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const k of THEME_VARS) {
    const v = cs.getPropertyValue(`--color-${k}`).trim();
    if (v) colors[k] = cssColorToHexString(v);
  }
  const t = getTheme();
  return {
    colors,
    mode: t.mode,
    accent: cssColorToHexString(ACCENTS[t.accent].brand),
    radius: t.radius,
    fonts: { ui: t.uiFont, mono: t.monoFont },
    surface: cssColorToHexString(t.palette.bg2),
    terminalBackground: cssColorToHexString(t.terminal.background),
    glass: effectiveGlass(t),
    // The same status tokens every surface of the app paints with, resolved for the view.
    status: Object.fromEntries(STATUS_TONES.flatMap((tone) => {
      const v = cs.getPropertyValue(`--color-status-${tone}`).trim();
      return v ? [[tone, cssColorToHexString(v)]] : [];
    })),
  };
}

/** Plugin layout blobs are opaque to the host: `{ v: 1, data: <whatever the plugin sent> }`. */
function layoutSpec(pluginId: string): ViewLayoutSpec<unknown> {
  return { viewId: pluginId, version: 1, initial: () => null, migrate: () => null };
}

/** The host for one package. Rendered through the lazy wrapper in registry.ts
 *  (`pkg` is fixed per registered view; the props are the view contract). */
export function CommunityViewHost({ pkg, model, commands }: WorkspaceViewProps & { pkg: ViewPackageInfo }) {
  const manifest = pkg.manifest!;
  const url = pkg.url!;
  const capabilities = useMemo(() => manifest.permissions as ViewPermission[], [manifest]);
  return <CommunityView pkg={pkg} url={url} manifest={manifest} capabilities={capabilities} model={model} commands={commands} />;
}

function CommunityView({ pkg, url, manifest, capabilities, model, commands }: WorkspaceViewProps & { pkg: ViewPackageInfo; url: string; manifest: NonNullable<ViewPackageInfo["manifest"]>; capabilities: ViewPermission[] }) {
  {
    const { frames, tiles, frameOf, layerTiles, selectedTileId, selectedFrameId, layoutKey } = model;
    const rootRef = useRef<HTMLDivElement>(null);
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const linkRef = useRef<CommunityLink | null>(null);
    const [ready, setReady] = useState(false);
    const [rects, setRects] = useState<SurfaceRect[]>([]);
    const commandsRef = useRef(commands);
    commandsRef.current = commands;
    const tilesRef = useRef(tiles);
    tilesRef.current = tiles;
    const framesRef = useRef(frames);
    framesRef.current = frames;

    // ── the link: created once per mount, attached when the iframe loads ─────
    // Plugin messages arrive one task each, so "selectTile(null)" + "rects: []"
    // (an undock) would be two React commits: the first deselects the tile
    // while it is still visible in its slot — which, on a low-DPI screen, swaps
    // it from the DOM renderer back to WebGL (a GL context + atlas, 0.5 s on
    // software GL) — and only the second parks it. Everything a plugin sends
    // within one animation frame is applied together instead, in one commit,
    // exactly like the built-in views' own handlers; the ≤16 ms is invisible.
    const batch = useRef<Array<() => void>>([]);
    const batchRaf = useRef(0);
    const enqueue = (fn: () => void) => {
      batch.current.push(fn);
      if (batchRaf.current) return;
      batchRaf.current = requestAnimationFrame(() => {
        batchRaf.current = 0;
        const fns = batch.current; batch.current = [];
        for (const f of fns) f();
      });
    };
    useEffect(() => () => { if (batchRaf.current) cancelAnimationFrame(batchRaf.current); }, []);
    const link = useMemo(() => new CommunityLink({
      pluginId: pkg.id,
      capabilities,
      commands: new Proxy({} as WorkspaceViewProps["commands"], {
        get: (_t, k) => {
          const name = k as keyof WorkspaceViewProps["commands"];
          // Status subscriptions are not state changes — keep them immediate.
          if (name === "subscribeTileStatus" || name === "tileStatus") return commandsRef.current[name];
          return (...args: unknown[]) => enqueue(() => (commandsRef.current[name] as (...a: unknown[]) => void)(...args));
        },
      }),
      hasTile: (id) => tilesRef.current.some((t) => t.id === id),
      hasFrame: (id) => framesRef.current.some((f) => f.id === id),
      onReady: () => setReady(true),
      onSurfaceRects: (r) => enqueue(() => setRects(r)),
      onLayout: (data) => saveViewLayout(layoutSpec(pkg.id), layoutKey, data),
      onFramesDrawn: () => { /* read from stats by the test seam / perf harness */ },
      onError: (message) => console.warn(`[hivemind] view "${pkg.id}": ${message}`),
      onDisable: (reason) => {
        toast.error(`The ${manifest.name} view was disabled: ${reason}. Switched back to Canvas — your tiles are untouched.`);
        disableCommunityView(pkg.id, reason);
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []);
    linkRef.current = link;
    useEffect(() => () => link.dispose(), [link]);

    const onLoad = useCallback(() => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      const ch = new MessageChannel();
      link.attach(ch.port1);
      // The frame's origin is opaque (sandbox without allow-same-origin), so
      // the only valid target is "*"; nothing but the port travels with it.
      win.postMessage({ type: PORT_HANDSHAKE }, "*", [ch.port2]);
    }, [link]);

    // ── hello + projection ──────────────────────────────────────────────────
    const send = useCallback((m: HostMessage) => linkRef.current?.send(m), []);
    const box = () => {
      const r = rootRef.current?.getBoundingClientRect();
      return { w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0) };
    };
    useEffect(() => {
      if (!ready) return;
      send({
        type: "hello", v: PROTOCOL_VERSION, pluginId: pkg.id, capabilities,
        theme: readTheme(), layout: loadViewLayout(layoutSpec(pkg.id), layoutKey),
        viewport: box(), visible: !document.hidden,
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready]);

    // A frame bound to a machine carries that machine's name and link state; a local one carries nothing.
    const machines = useMachines();
    const machineOf = useCallback((workspacePath?: string): { machine?: ViewFrameMachine } => {
      const hostId = hostIdOfUri(workspacePath);
      if (!hostId) return {};
      const s = statusOf(machines, hostId);
      const name = machineByHost(machines, hostId)?.label ?? hostId.replace(/:22$/, "");
      return { machine: { name, state: s.state, ...(s.rttMs !== undefined ? { rttMs: s.rttMs } : {}) } };
    }, [machines]);

    // Structure: frames / tiles / membership (+ current names). Colours resolved.
    const nameOf = useMemo(() => new Map(layerTiles.map((t) => [t.id, t.name])), [layerTiles]);
    const nameRef = useRef(nameOf);
    nameRef.current = nameOf;
    useEffect(() => {
      if (!ready) return;
      send({
        type: "structure",
        frames: frames.map((f) => ({ id: f.id, title: f.title, color: cssColorToHexString(f.color), ...machineOf(f.workspacePath) })),
        tiles: tiles.map((t) => ({ id: t.id, frameId: frameOf[t.id] ?? null, kind: t.kind, name: nameRef.current.get(t.id) ?? t.label })),
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready, frames, tiles, frameOf, machineOf]);
    // Names on their own — a title tick must not look structural to the plugin.
    const lastNames = useRef("");
    useEffect(() => {
      if (!ready) return;
      const names: Record<string, string> = {};
      for (const [id, n] of nameOf) names[id] = n;
      const key = JSON.stringify(names);
      if (key === lastNames.current) return;
      lastNames.current = key;
      send({ type: "names", names });
    }, [ready, nameOf, send]);
    // Selection, with "fresh": the selection you arrive with is not.
    const selSent = useRef(false);
    useEffect(() => {
      if (!ready) return;
      send({ type: "selection", tileId: selectedTileId, frameId: selectedFrameId, fresh: selSent.current });
      selSent.current = true;
    }, [ready, selectedTileId, selectedFrameId, send]);
    // Closed tiles drop their status subscription; the plugin sees them go in `structure`.
    const prevTiles = useRef(new Set<string>());
    useEffect(() => {
      const now = new Set(tiles.map((t) => t.id));
      for (const id of prevTiles.current) if (!now.has(id)) link.dropTile(id);
      prevTiles.current = now;
    }, [tiles, link]);

    // ── viewport / visibility / theme ───────────────────────────────────────
    useLayoutEffect(() => {
      const el = rootRef.current;
      if (!el) return;
      const ro = new ResizeObserver(() => { if (linkRef.current?.stats.ready) send({ type: "resize", ...box() }); });
      ro.observe(el);
      const onVis = () => send({ type: "visibility", visible: !document.hidden });
      document.addEventListener("visibilitychange", onVis);
      // Any appearance change (a preset from Settings, `hive theme use`, a
      // slider) lands on <html>'s style/class; coalesce to one theme message.
      let themeTimer = 0;
      const mo = new MutationObserver(() => {
        if (!linkRef.current?.stats.ready) return;
        if (themeTimer) return;
        themeTimer = window.setTimeout(() => { themeTimer = 0; send({ type: "theme", theme: readTheme() }); }, 50);
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-preset", "style"] });
      return () => { ro.disconnect(); document.removeEventListener("visibilitychange", onVis); mo.disconnect(); if (themeTimer) clearTimeout(themeTimer); };
    }, [send]);

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
    const hostBox = useMemo(() => box(), [rects]); // eslint-disable-line react-hooks/exhaustive-deps
    const policy = useSurfacePolicy();
    const clip = useMemo(() => edgeBandClip(rects, hostBox), [rects, hostBox]);

    return (
      <div ref={rootRef} className="relative flex-1 min-h-0 overflow-hidden" data-community-view={pkg.id} data-community-ready={ready ? "1" : "0"}>
        <iframe
          ref={iframeRef}
          name={`hm-view:${pkg.id}`}
          title={manifest.name}
          src={url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={onLoad}
          className="absolute inset-0 h-full w-full border-0 bg-transparent"
          style={clip ? { clipPath: clip } : undefined}
          data-community-clip={clip ?? undefined}
        />
        {/* The hole-punch overlay: one live slot per rect, pointer events only
            on the slots. Unless the rect says `chrome: "none"`, the host's slot
            bar sits at the top of it (name, status, pop-out, undock). */}
        <div className="pointer-events-none absolute inset-0" data-community-surfaces>
          {rects.map((r) => (
            <div
              key={r.tileId}
              className="pointer-events-auto absolute flex flex-col overflow-hidden bg-[var(--color-bg)]"
              // App's top-right New/Settings cluster overlays every view; a slot
              // flush with the top-right corner keeps its bar below it (the
              // World's dock pane does the same with pt-12).
              style={{ left: r.x, top: r.y, width: r.w, height: r.h, paddingTop: r.y <= 1 && r.x + r.w >= hostBox.w - 1 ? 48 : 0 }}
              data-community-slot={r.tileId}
            >
              {/* The user's theme wins everywhere: with pluginSurfaces "theme"
                  the wallpaper is painted behind THIS slot only (clipped by the
                  slot box), so the docked terminal frosts exactly as on the
                  canvas while nothing full-window is composited. */}
              {policy.slotWallpaper && <Wallpaper embedded />}
              {r.chrome !== "none" && (
                <div className="relative z-10 shrink-0">
                  <SlotBar tileId={r.tileId} name={nameOf.get(r.tileId) ?? r.tileId} commands={commands} onUndock={() => undock(r.tileId)} />
                </div>
              )}
              <TileSlot tileId={r.tileId} transient className="relative z-10 min-h-0 flex-1" />
            </div>
          ))}
        </div>
        {!ready && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-[12px] text-[var(--color-fg3)]">
            Loading {manifest.name}…
          </div>
        )}
      </div>
    );
  }
}
