/**
 * Tile plugins installed on this machine. Each draws its tiles as a page in a sandboxed frame:
 * no access to the app, the network or the disk, only the messages below. The page reaches the
 * machine by asking for a program its manifest declared; the main process checks the rest.
 *
 *   page → host  { type: "hive:call", id, method: "exec", bin, args, maxAgeMs? }
 *   host → page  { type: "hive:reply", id, ok, value | error }
 *   host → page  { type: "hive:init", tile: { id, kind, repoPath, root }, theme }   (and again on change)
 *   page → host  { type: "hive:close" }
 */
import { useEffect, useRef } from "react";
import type { TilePluginPackage } from "../../../shared/ipc";
import { registerTile, type TileBodyArgs } from "./api";

type PluginTileData = { plugin: string; tileId: string; kind: string; repoPath: string | null; cwd: string; root: string | null; onClose: () => void };

const THEME_VARS = ["--color-bg", "--color-bg2", "--color-bg3", "--color-fg", "--color-fg2", "--color-fg3", "--color-line", "--color-brand", "--color-err", "--font-mono"];
const theme = (): Record<string, string> => {
  const css = getComputedStyle(document.documentElement);
  return Object.fromEntries(THEME_VARS.map((v) => [v, css.getPropertyValue(v).trim()]));
};

function PluginFrame({ src, data }: { src: string; data: PluginTileData }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const post = (msg: unknown) => ref.current?.contentWindow?.postMessage(msg, "*");
  const init = () => {
    const d = dataRef.current;
    post({ type: "hive:init", tile: { id: d.tileId, kind: d.kind, repoPath: d.repoPath, root: d.root }, theme: theme() });
  };
  useEffect(init, [data.tileId, data.kind, data.repoPath, data.root]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only this tile's own frame; a sandboxed page has an opaque origin, so match the window.
      if (e.source !== ref.current?.contentWindow) return;
      const m = e.data as { type?: unknown; id?: unknown; method?: unknown; bin?: unknown; args?: unknown; maxAgeMs?: unknown };
      if (m?.type === "hive:close") { dataRef.current.onClose(); return; }
      if (m?.type !== "hive:call" || typeof m.id !== "number") return;
      const d = dataRef.current;
      // The folder is the tile's, never one the page names.
      window.hive.callTilePlugin({
        plugin: d.plugin, method: "exec", bin: String(m.bin), args: Array.isArray(m.args) ? m.args.map(String) : [],
        cwd: d.repoPath ?? d.cwd, maxAgeMs: typeof m.maxAgeMs === "number" ? m.maxAgeMs : undefined,
      }).then(
        (value) => post({ type: "hive:reply", id: m.id, ok: true, value }),
        (err: unknown) => post({ type: "hive:reply", id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={ref}
      title={data.kind}
      sandbox="allow-scripts"
      src={src}
      onLoad={init}
      className="nodrag nowheel w-full h-full border-0 bg-[var(--color-bg2)] rounded-[inherit]"
      data-tile-plugin={data.plugin}
    />
  );
}

export function registerInstalled(pkg: TilePluginPackage): void {
  const Body = ({ data }: TileBodyArgs<PluginTileData>) => <PluginFrame src={pkg.entry} data={data} />;
  registerTile<PluginTileData>({
    surface: `plugin-${pkg.id}`,
    name: pkg.name,
    kinds: Object.fromEntries(Object.entries(pkg.kinds).map(([kind, k]) => [kind, {
      size: k.size, label: k.title, title: k.title, glyph: k.glyph, needsRepo: k.needsRepo, singleton: k.singleton,
    }])),
    data: (t, s) => ({ plugin: pkg.id, tileId: t.id, kind: t.kind, repoPath: s.repoPath, cwd: s.cwd, root: s.root, onClose: s.onClose }),
    body: async () => ({ default: Body }),
    minSize: { width: 240, height: 160 },
  });
}

/** Load and register every installed tile plugin. One that clashes with a kind already drawn is skipped. */
export async function loadInstalledTiles(): Promise<void> {
  const pkgs = await window.hive.listTilePlugins().catch(() => [] as TilePluginPackage[]);
  for (const pkg of pkgs) {
    try { registerInstalled(pkg); } catch (err) { console.warn(`[tiles] ${pkg.id}:`, err); }
  }
}
