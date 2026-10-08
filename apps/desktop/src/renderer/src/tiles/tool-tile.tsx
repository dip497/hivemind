/**
 * One tool plugin's tile: the plugin's component, handed the `hm` client a view gets (linked in
 * this window, held to the permissions its manifest declares) and a `host` for what only a tile
 * has. Loaded with the first tile of a tool plugin, so the app starts without it.
 */
import { Loading } from "../components/ui/loading";
import { useContext, useEffect, useRef, useState, type ComponentType } from "react";
import { GripVertical } from "../components/icons";
import { connect, type ViewClient } from "@hivemind/view-sdk";
import { PORT_HANDSHAKE } from "@hivemind/view-sdk/protocol";
import type { ToolPackage } from "@hivemind/core/tool-format";
import type { TileHost, TileProps } from "@hivemind/tile-sdk";
import { usePluginLink } from "../workspace/plugin-link";
import { WorkspacePropsContext } from "../workspace/workspace-props";
import type { WorkspaceViewProps } from "../workspace/workspace-view";
import { HeaderPinButton } from "../canvas-nodes";
import { Button } from "../components/ui/button";
import type { PinRect } from "./api";

export type ToolTileData = {
  pkg: ToolPackage; tileId: string; kind: string; name: string; frameId: string | null;
  repoPath: string | null; cwd: string;
  /** The `.hivemind` root of its frame, whose issues its `hm` is given. */
  root: string | null;
  glyph?: string;
  openUrl: (url: string) => void; openFile: (path: string) => void;
  onClose: () => void; pinned?: boolean; onTogglePin?: (id: string, rect: PinRect) => void;
};

/** The bar the app draws on every tool's tile, as on its own: what it is, pin, close; dragged by. */
function ToolBar({ data }: { data: ToolTileData }) {
  return (
    <div data-tile-titlebar className="tile-drag-handle h-8 shrink-0 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
      <GripVertical size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
      {data.glyph && <span aria-hidden className="text-[var(--color-fg3)]">{data.glyph}</span>}
      <span className="font-semibold text-[var(--color-fg)] truncate">{data.name}</span>
      <span className="ml-auto" />
      <HeaderPinButton tileId={data.tileId} pinned={data.pinned} onToggle={data.onTogglePin} />
      <Button variant="ghost" size="icon-2xs" className="nodrag" aria-label="close tile" title="close" onClick={data.onClose}>
        <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </Button>
    </div>
  );
}

export function ToolTile({ data, selected, Draw }: { data: ToolTileData; selected: boolean; Draw: ComponentType<TileProps> }) {
  const props = useContext(WorkspacePropsContext);
  if (!props) return <div className="p-4 text-[12px] text-[var(--color-fg3)]">This tile is shown outside a workspace.</div>;
  return <LinkedTile data={data} selected={selected} Draw={Draw} props={props} />;
}

function LinkedTile({ data, selected, Draw, props }: { data: ToolTileData; selected: boolean; Draw: ComponentType<TileProps>; props: WorkspaceViewProps }) {
  const root = useRef<HTMLDivElement>(null);
  const [hm, setHm] = useState<ViewClient | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { link, dialogs } = usePluginLink({
    pluginId: data.pkg.id, record: { kind: "tool", id: data.pkg.id }, name: data.pkg.name,
    capabilities: data.pkg.permissions, fields: data.pkg.settings, layoutId: `tile:${data.tileId}`, issueRoot: () => dataRef.current.root, issueFolder: () => dataRef.current.repoPath ?? dataRef.current.cwd,
    props, root, onDisable: (reason) => setFailed(reason),
    commands: data.pkg.pluginCommands, instance: { id: data.tileId, label: data.name },
  });
  useEffect(() => {
    const ch = new MessageChannel();
    link.attach(ch.port1);
    const target = new EventTarget();
    let live = true;
    connect({ target: target as unknown as Window, timeoutMs: 10_000 }).then((c) => { if (live) setHm(c); }, (e: Error) => { if (live) setFailed(e.message); });
    target.dispatchEvent(new MessageEvent("message", { data: { type: PORT_HANDSHAKE }, ports: [ch.port2] }));
    return () => { live = false; };
  }, [link]);
  const dataRef = useRef(data);
  dataRef.current = data;
  const host = useRef<TileHost>({
    get repoPath() { return dataRef.current.repoPath; },
    get cwd() { return dataRef.current.cwd; },
    run: (bin, args, opts) => window.hive.toolRun({ bin, args, cwd: dataRef.current.repoPath ?? dataRef.current.cwd, ...opts }),
    openFile: (path) => dataRef.current.openFile(path),
    openUrl: (url) => { if (/^https?:\/\//i.test(url)) dataRef.current.openUrl(url); },
  }).current;
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[inherit] bg-[var(--color-bg2)]" data-tool-plugin={data.pkg.id}>
      <ToolBar data={data} />
      <div ref={root} className="nodrag nowheel relative min-h-0 flex-1 overflow-hidden">
        {failed ? <div className="p-4 text-[12px] text-[var(--color-err)]">{data.pkg.name} stopped: {failed}</div>
          : hm ? <Draw tile={{ id: data.tileId, kind: data.kind, name: data.name, frameId: data.frameId }} hm={hm} host={host} selected={selected} />
          : <Loading label={`Starting ${data.pkg.name}`} />}
      </div>
      {dialogs}
    </div>
  );
}
