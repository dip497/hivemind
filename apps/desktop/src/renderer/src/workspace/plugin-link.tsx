/**
 * The host end of a plugin's `hm` client, for every kind of plugin that has one: a view in its
 * sandboxed frame, a tool's tile in the app itself. One link per plugin instance
 * (`@hivemind/view-host/link`): the plugin is told the workspace (`hello`, `structure`, `names`,
 * `selection`, theme, settings) and asks through the protocol's commands and requests, each held
 * to the permissions its manifest was granted. Who holds the other end of the port is the
 * caller's: a frame's window, or a client in this window.
 */
import { inEditable } from "../dom-focus";
import { chordMatches, type PluginCommand } from "@hivemind/view-sdk/commands";
import type { Running } from "@hivemind/view-host/instances";
import { pluginInstances } from "./plugin-instances";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { PROTOCOL_VERSION, type HostMenu, type HostMessage, type ShareOutcome, type SurfaceRect, type ViewPermission, type ViewRect } from "@hivemind/view-sdk/protocol";
import type { SettingField } from "@hivemind/view-sdk/settings";
import { resolveTokens, type TokenDecl } from "@hivemind/view-sdk/tokens";
import { CommunityLink } from "@hivemind/view-host/link";
import { viewStructure } from "@hivemind/view-host/structure";
import { isRemote } from "@hivemind/core/remote-uri";
import { agentById as catalogAgentById } from "@hivemind/agents";
import { agentToStart } from "../agent-plugins";
import { pluginOptions, resolveSettings, type PluginKind } from "@hivemind/core/plugin-settings";
import { frameMachine, useMachines } from "../machines/store";
import { useMachineOwners } from "../machines/owners";
import { useShown } from "../multiplayer/shown";
import { useSettings } from "../settings-store";
import { AGENT_TILE_KIND } from "../tile-kinds";
import { canSpawnKind } from "../tiles/api";
import type { SharePrepared } from "../../../shared/ipc";
import { TILE_KEYBOARD, type WorkspaceViewProps } from "./workspace-view";
import { loadViewLayout, saveViewLayout, type ViewLayoutSpec } from "./view-layout-store";
import { cssColorToHexString } from "./css-color";
import { viewLinkServices } from "./view-services";
import { readTheme } from "./plugin-theme";
import { viewFontFaces } from "./view-fonts";
import { getTheme, useThemeField } from "../theme-store";
import { ShareDialog, type ShareChoice } from "./views/community/ShareDialog";
import { PromptDialog, type PromptAsk } from "./views/community/PromptDialog";
import { tileMarkSvg } from "../tiles/mark-svg";

/** Plugin layout blobs are opaque to the host: `{ v: 1, data: <whatever the plugin sent> }`. */
export function layoutSpec(id: string, personal = false): ViewLayoutSpec<unknown> {
  return { viewId: id, version: 1, initial: () => null, ...(personal ? { personal: true } : {}) };
}

export interface PluginLinkOptions {
  /** The plugin's id, as the protocol names it to the plugin and in events meant for it. */
  pluginId: string;
  /** Its kind and id in the plugin record, whose stored values its `settings` are. */
  record: { kind: PluginKind; id: string };
  /** What a person calls it, in the dialogs it opens. */
  name: string;
  capabilities: ViewPermission[];
  fields: readonly SettingField[];
  /** Its own colours (a view's manifest `tokens`), sent with the theme, resolved for it and for
   *  what the person set (each is one of `fields`, `token-<id>`). */
  tokens?: readonly TokenDecl[];
  /** Where its saved layout is kept (`hello.layout`, `setLayout`); `personal`: on this device. */
  layoutId: string;
  personal?: boolean;
  props: WorkspaceViewProps;
  /** The box it draws in, for `viewport` and `resize`. */
  root: RefObject<HTMLElement | null>;
  /** The `.hivemind` root whose issues it is given: a tool's tile, its frame's; absent, the workspace's. */
  issueRoot?: () => string | null;
  /** Where issues would be set up: the tile's folder; a view's is the workspace's. */
  issueFolder?: () => string | null;
  /** Where it asks for live surfaces; absent: it places none. */
  onSurfaceRects?: (rects: SurfaceRect[]) => void;
  /** What an agent may run in it while it runs (its manifest's `commands`), and which copy this is. */
  commands?: readonly PluginCommand[];
  instance?: { id: string; label: string };
  onDisable: (reason: string) => void;
}

export interface PluginLink {
  link: CommunityLink;
  ready: boolean;
  send: (m: HostMessage) => void;
  /** The share and prompt dialogs it may open: render them in its box. */
  dialogs: ReactNode;
  /** Its code broke: it is failed, with why. */
  fail: (reason: string) => void;
  /** Its code painted its first content. */
  drew: () => void;
}

export function usePluginLink(o: PluginLinkOptions): PluginLink {
  const { model, commands } = o.props;
  const { frames, tiles, frameOf, layerTiles, links, selectedTileId, selectedFrameId, layoutKey } = model;
  const linkRef = useRef<CommunityLink | null>(null);
  const [ready, setReady] = useState(false);
  /** This plugin in the window's lifecycle of running plugins, from its mount to its unmount. */
  const running = useRef<Running | null>(null);
  const optsRef = useRef(o);
  optsRef.current = o;
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const layerTilesRef = useRef(layerTiles);
  layerTilesRef.current = layerTiles;
  const repoRef = useRef(model.repoPath);
  repoRef.current = model.repoPath;
  const rootRef = useRef(model.root);
  rootRef.current = model.root;
  const layoutKeyRef = useRef(layoutKey);
  layoutKeyRef.current = layoutKey;

  // Everything a plugin sends within one animation frame is applied together, in one commit: an
  // undock is "selectTile(null)" and "rects: []", and between the two the tile would flash.
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

  // A share waits here for the person's choice in the host dialog.
  const [shareImage, setShareImage] = useState<SharePrepared | null>(null);
  const shareAnswer = useRef<((c: ShareChoice) => void) | null>(null);
  const share = async (png: ArrayBuffer, suggestedName?: string): Promise<ShareOutcome> => {
    const { viewSharePrepare, viewShareCommit } = window.hive;
    if (!viewSharePrepare || !viewShareCommit) return "cancelled";
    const prepared = await viewSharePrepare(png);
    const choice = await new Promise<ShareChoice>((resolve) => { shareAnswer.current = resolve; setShareImage(prepared); });
    shareAnswer.current = null;
    setShareImage(null);
    return viewShareCommit(prepared.token, choice, suggestedName ?? optsRef.current.name);
  };
  // A prompt the plugin wrote waits here for the person to read it and send or cancel it.
  const [promptAsk, setPromptAsk] = useState<PromptAsk | null>(null);
  const promptAnswer = useRef<((send: boolean) => void) | null>(null);
  const confirmPrompt = async (req: { agent: string | null; tileId?: string; frameId: string | null; text: string }): Promise<boolean> => {
    const tile = req.tileId ? layerTilesRef.current.find((t) => t.id === req.tileId) : undefined;
    const frameId = tile?.frameId ?? req.frameId;
    const frame = frameId ? framesRef.current.find((f) => f.id === frameId) : undefined;
    const agentId = tile?.agent ?? req.agent;
    const agent = (agentId ? catalogAgentById(agentId) : agentToStart())?.label ?? "an agent";
    const where = tile ? `To the tile “${tile.name}”` : `A new ${agent} tile${frame ? ` in “${frame.title}”` : ""}`;
    const send = await new Promise<boolean>((resolve) => { promptAnswer.current = resolve; setPromptAsk({ viewName: optsRef.current.name, agent, where, text: req.text }); });
    promptAnswer.current = null;
    setPromptAsk(null);
    return send;
  };

  const link = useMemo(() => new CommunityLink({
    pluginId: o.pluginId,
    capabilities: o.capabilities,
    canSpawn: canSpawnKind,
    commands: new Proxy({} as WorkspaceViewProps["commands"], {
      get: (_t, k) => {
        const name = k as keyof WorkspaceViewProps["commands"];
        // Status subscriptions are not state changes: keep them immediate.
        if (name === "subscribeTileStatus" || name === "tileStatus") return commandsRef.current[name];
        // Its answer (was the agent found?) is what the link checks, so it cannot wait for the batch.
        if (name === "spawnAgent") return (...args: Parameters<WorkspaceViewProps["commands"]["spawnAgent"]>) => commandsRef.current.spawnAgent(...args);
        // The view's frame holds the focus after any click in it: the tile it selects gets the keyboard back.
        if (name === "selectTile") return (id: string | null) => enqueue(() => {
          commandsRef.current.selectTile(id);
          if (id) window.dispatchEvent(new CustomEvent(TILE_KEYBOARD, { detail: id }));
        });
        // The view says where its button is in its own pixels: the menu opens there in the window's.
        if (name === "openHostMenu") return (menu: HostMenu, at?: ViewRect) => enqueue(() => {
          const r = optsRef.current.root.current?.getBoundingClientRect();
          commandsRef.current.openHostMenu(menu, at && r ? { ...at, x: at.x + r.left, y: at.y + r.top } : at);
        });
        return (...args: unknown[]) => enqueue(() => (commandsRef.current[name] as (...a: unknown[]) => void)(...args));
      },
    }),
    hasTile: (id) => tilesRef.current.some((t) => t.id === id),
    hasFrame: (id) => framesRef.current.some((f) => f.id === id),
    onReady: () => setReady(true),
    ...(o.onSurfaceRects ? { onSurfaceRects: (r: SurfaceRect[]) => enqueue(() => optsRef.current.onSurfaceRects?.(r)) } : {}),
    onLayout: (data) => saveViewLayout(layoutSpec(optsRef.current.layoutId, optsRef.current.personal), layoutKeyRef.current, data),
    onFramesDrawn: () => { /* read from stats by the perf harness */ },
    onError: (message) => console.warn(`[hivemind] plugin "${o.pluginId}": ${message}`),
    services: viewLinkServices({
      layoutKey: () => layoutKeyRef.current,
      repo: () => repoRef.current,
      share,
      frameFolder: (frameId) => {
        const f = framesRef.current.find((x) => x.id === frameId);
        // Same rule as a tile's working directory: the frame's own folder, else the workspace's.
        const folder = f ? f.worktreePath ?? f.workspacePath ?? repoRef.current : null;
        return folder && !isRemote(folder) ? folder : null;
      },
      isAgentTile: (tileId) => tilesRef.current.some((t) => t.id === tileId && t.kind === AGENT_TILE_KIND),
      confirmPrompt,
      issueRoot: () => optsRef.current.issueRoot?.() ?? rootRef.current,
      issueFolder: () => { const d = optsRef.current.issueFolder?.() ?? repoRef.current; return d && !isRemote(d) ? d : null; },
    }),
    onDisable: (reason) => { running.current?.disabled(reason); optsRef.current.onDisable(reason); },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  linkRef.current = link;
  useEffect(() => () => { shareAnswer.current?.("cancel"); promptAnswer.current?.(false); link.dispose(); }, [link]);

  const send = useCallback((m: HostMessage) => linkRef.current?.send(m), []);
  const box = () => {
    const r = optsRef.current.root.current?.getBoundingClientRect();
    return { w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0) };
  };
  // What the person set this plugin to (Settings ▸ Plugins), one value per field it declares.
  const stored = useSettings().plugins.state;
  const settings = useMemo(() => resolveSettings(o.fields, pluginOptions(stored, o.record.kind, o.record.id)), [o.fields, stored, o.record.kind, o.record.id]);
  const settingsKey = JSON.stringify(settings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /** The theme as this plugin is told it: the app's, and its own tokens resolved in it. */
  const theme = () => {
    const t = readTheme(), tokens = optsRef.current.tokens;
    return tokens?.length ? { ...t, tokens: resolveTokens(tokens, t.mode, t.colors, settingsRef.current) } : t;
  };
  // The theme's font faces (1.17): in hello when their bytes are read already, else in `fonts` once
  // they are, and again only when they change.
  const fontFaces = useThemeField("fontFaces");
  const sentFonts = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const fonts = viewFontFaces(getTheme().fontFaces);
    if (fonts.done) sentFonts.current = fonts.key;
    send({
      type: "hello", v: PROTOCOL_VERSION, ...(fonts.done?.length ? { fontFaces: fonts.done } : {}), pluginId: o.pluginId, capabilities: o.capabilities, settings: settingsRef.current,
      theme: theme(), layout: loadViewLayout(layoutSpec(o.layoutId, o.personal), layoutKey),
      viewport: box(), visible: !document.hidden, features: [...link.features, "settings", "tokens", "fontFaces"],
      // A desktop: whether its pointer is a finger, never a phone's screen.
      device: { touch: matchMedia("(pointer: coarse)").matches, compact: false },
      keys: (o.commands ?? []).flatMap((c) => (c.keys ? [{ keys: c.keys, command: c.name }] : [])),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    const fonts = viewFontFaces(fontFaces);
    if (sentFonts.current === fonts.key) return;
    let live = true;
    void fonts.faces.then((faces) => {
      if (!live || sentFonts.current === fonts.key) return;
      sentFonts.current = fonts.key;
      send({ type: "fonts", fontFaces: faces });
    });
    return () => { live = false; };
  }, [ready, fontFaces, send]);
  const sentSettings = useRef(settingsKey);
  useEffect(() => {
    if (!ready || sentSettings.current === settingsKey) return;
    sentSettings.current = settingsKey;
    send({ type: "settings", settings: settingsRef.current });
    // A token's colour is one of its settings: set, the theme it paints with changes too.
    if (optsRef.current.tokens?.length) send({ type: "theme", theme: theme() });
  }, [ready, settingsKey, send]);

  // A frame bound to a machine carries that machine's name and link state; a local one carries nothing.
  const machines = useMachines();
  const owners = useMachineOwners(useShown().repo);
  const machineOf = useCallback((workspacePath?: string) => frameMachine(machines, workspacePath, owners), [machines, owners]);

  // Structure: frames, tiles and membership, with the current names and colours resolved.
  const nameOf = useMemo(() => new Map(layerTiles.map((t) => [t.id, t.name])), [layerTiles]);
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;
  const agentOf = useMemo(() => new Map(layerTiles.flatMap((t) => (t.agent ? [[t.id, t.agent] as const] : []))), [layerTiles]);
  useEffect(() => {
    if (!ready) return;
    send(viewStructure({
      frames, tiles, frameOf,
      name: (t) => nameRef.current.get(t.id),
      agent: (t) => agentOf.get(t.id),
      icon: (t) => tileMarkSvg(t.kind, agentOf.get(t.id)),
      links: { pipes: links.pipes, spawns: links.spawnLinks },
      color: (f) => cssColorToHexString(f.color),
      machine: (f) => machineOf(f.workspacePath),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, frames, tiles, frameOf, machineOf, agentOf, links]);
  // Names on their own: a title tick must not look structural to the plugin.
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
  // Selection, with "fresh": the selection it arrives with is not.
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

  // Viewport, visibility and theme.
  useLayoutEffect(() => {
    const el = optsRef.current.root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (linkRef.current?.stats.ready) send({ type: "resize", ...box() }); });
    ro.observe(el);
    const onVis = () => { linkRef.current?.setVisible(!document.hidden); send({ type: "visibility", visible: !document.hidden }); };
    document.addEventListener("visibilitychange", onVis);
    // Any appearance change lands on <html>'s style or class; coalesce to one theme message.
    let themeTimer = 0;
    const mo = new MutationObserver(() => {
      if (!linkRef.current?.stats.ready || themeTimer) return;
      themeTimer = window.setTimeout(() => { themeTimer = 0; send({ type: "theme", theme: theme() }); }, 50);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-preset", "style"] });
    return () => { ro.disconnect(); document.removeEventListener("visibilitychange", onVis); mo.disconnect(); if (themeTimer) clearTimeout(themeTimer); };
  }, [send]);

  // What an agent reads of it and calls in it (`hive ctl plugin list|call`): every plugin, with or
  // without commands, starting from its mount, ready once its code has connected, so a call waits
  // for one still loading rather than missing it.
  const declared = o.commands ?? [];
  const declaredKey = JSON.stringify(declared);
  const instanceId = o.instance?.id ?? o.layoutId;
  const instanceLabel = o.instance?.label ?? o.name;
  useEffect(() => {
    const r = pluginInstances.start({
      plugin: o.pluginId, kind: o.record.kind as "tool" | "widget" | "view", instance: instanceId, label: optsRef.current.instance?.label ?? optsRef.current.name,
      commands: optsRef.current.commands ?? [], call: (name, args, timeoutMs) => link.invoke(name, args, timeoutMs),
    });
    if (link.stats.disabled) r.disabled(link.stats.disabled);
    else if (link.stats.ready) r.connected();
    running.current = r;
    return () => { r.stop(); if (running.current === r) running.current = null; };
  }, [link, o.pluginId, o.record.kind, instanceId]);
  useEffect(() => { if (ready) running.current?.connected(); }, [ready]);
  useEffect(() => {
    running.current?.update({ label: instanceLabel, commands: declared });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- declaredKey stands for `declared`
  }, [instanceLabel, declaredKey]);

  // The active view's keys run while nothing is typed into: in a terminal or a field the key is
  // theirs. In its own frame its client runs them (`hello.keys`).
  useEffect(() => {
    const bound = declared.filter((c) => c.keys);
    if (!bound.length || !ready || o.record.kind !== "view") return;
    const mac = /mac/i.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      if (inEditable(e.target) || (e.target as Element | null)?.closest?.('[role="dialog"]')) return;
      const c = bound.find((x) => chordMatches(x.keys!, e, mac));
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      link.invoke(c.name, null).catch(() => {});
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- declaredKey stands for `declared`
  }, [link, ready, declaredKey, o.record.kind]);

  const dialogs = (
    <>
      <ShareDialog viewName={o.name} image={shareImage} onChoose={(c) => shareAnswer.current?.(c)} />
      <PromptDialog ask={promptAsk} onChoose={(s) => promptAnswer.current?.(s)} />
    </>
  );
  const fail = useCallback((reason: string) => running.current?.disabled(reason), []);
  const drew = useCallback(() => running.current?.drew(), []);
  return { link, ready, send, dialogs, fail, drew };
}
