/**
 * The Plugins page's packages: one row per package that holds several plugins, switched as one,
 * opened to its members. A member can be switched off on its own, and on only while its package
 * is on; what each is set to stays on its own page.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Puzzle } from "../components/icons";
import { Switch } from "../components/ui/switch";
import { useSettings } from "../settings-store";
import { useWidgetPackages } from "../board-objects/widget-runtime";
import { useToolPackages } from "../tiles/tool-plugins";
import { useCommunityReport } from "../workspace/views/community/registry";
import { rescan } from "../settings-views";
import { cleanError } from "../settings-plugins";
import { PluginRow } from "./PluginList";
import { packageRows, type PackageRow } from "./package-rows";
import type { InstalledPackageInfo } from "../../../shared/ipc";

const MEMBER_KIND: Record<string, string> = { tool: "Tool", widget: "Widget", view: "View", "agent-preset": "Agent preset" };

/** The installed packages, read again when the window comes back and after a switch. */
function useInstalledPackages(): [InstalledPackageInfo[], () => void] {
  const [list, setList] = useState<InstalledPackageInfo[]>([]);
  const load = useCallback(() => { void window.hive.installedPackages?.().then(setList, () => setList([])); }, []);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  return [list, load];
}

export function PackagesSection({ matches }: { matches: (text: string) => boolean }) {
  const [packages, reload] = useInstalledPackages();
  const state = useSettings().plugins.state;
  const widgets = useWidgetPackages();
  const tools = useToolPackages().packages;
  const views = useCommunityReport().packages;
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const nameOf = (kind: string, id: string) =>
    kind === "widget" ? widgets.find((w) => w.id === id)?.name
    : kind === "tool" ? tools.find((t) => t.id === id)?.name
    : kind === "view" ? views.find((v) => v.id === id)?.manifest?.name : undefined;
  const rows = packageRows(packages, state, nameOf, matches);
  if (!rows.length) return null;
  const act = async (id: string, fn: () => Promise<void>) => {
    setError(null);
    try { await fn(); } catch (e) { setError({ id, message: cleanError(e) }); }
    reload(); rescan();
  };
  return <section className="plugins-group" aria-label="Packages" data-plugins-kind="package">
    <h3 className="plugins-group-heading">Packages<span>{rows.length}</span></h3>
    <div className="plugin-rows">{rows.map((p) => <PackageRows key={p.id} p={p} open={open === p.id} toggle={() => setOpen(open === p.id ? null : p.id)}
      error={error?.id === p.id ? error.message : null} act={(fn) => void act(p.id, fn)} />)}</div>
  </section>;
}

function PackageRows({ p, open, toggle, error, act }: { p: PackageRow; open: boolean; toggle: () => void; error: string | null; act: (fn: () => Promise<void>) => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return <div className="package-item" data-package={p.id} data-open={open ? "" : undefined}>
    <div className="plugin-row" data-state={p.on ? "on" : "off"}>
      <button type="button" className="package-toggle" aria-expanded={open} aria-controls={`package-${p.id}`} onClick={toggle} data-package-open={p.id}>
        <Chevron size={15} className="plugin-row-mark" />
        <span className="plugin-row-text">
          <span className="plugin-row-name">{p.name}</span>
          <span className="plugin-row-detail">{p.id} {p.version} · {p.members.length} plugins</span>
        </span>
      </button>
      <Switch aria-label={`Switch ${p.name} ${p.on ? "off" : "on"}`} checked={p.on} data-package-switch={p.id}
        onCheckedChange={(on) => act(() => window.hive.switchPackage(p.id, on))} />
    </div>
    {error && <p role="alert" className="settings-note error">{error}</p>}
    {open && <div id={`package-${p.id}`} className="package-members" data-package-members={p.id}>
      {p.members.map((m) => m.own
        ? <PluginRow key={`${m.kind}:${m.id}`} kind={m.own.kind} id={m.id} name={m.name} mark={<Puzzle size={14} />}
          line={`${MEMBER_KIND[m.kind] ?? m.kind}${p.on ? "" : ", off with its package"}`} state={m.on ? "on" : "off"}
          action={<Switch aria-label={`Switch ${m.name} ${m.on ? "off" : "on"}`} checked={m.on} disabled={!m.on && !m.own.canTurnOn} data-member-switch={`${m.kind}:${m.id}`}
            onCheckedChange={(on) => act(() => window.hive.switchPlugin(m.own!.kind, m.id, on))} />} />
        : <div key={`${m.kind}:${m.id}`} className="plugin-row" data-state={m.on ? "on" : "off"} data-plugin-row={`${m.kind}:${m.id}`}>
          <span className="plugin-row-mark" aria-hidden="true"><Puzzle size={14} /></span>
          <span className="plugin-row-text"><span className="plugin-row-name">{m.name}</span>
            <span className="plugin-row-detail">{MEMBER_KIND[m.kind] ?? m.kind}, on and off with its package</span></span>
        </div>)}
    </div>}
  </div>;
}
