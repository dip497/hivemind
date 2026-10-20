/**
 * The Plugins page's Packages tab: one row per package that holds several plugins, switched as
 * one, opened to its members. A member can be switched off on its own, and on only while its
 * package is on; what each is set to stays on its own page. A package with a version before this
 * one can be rolled back to it.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, History } from "../components/icons";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { useSettings } from "../settings-store";
import { useWidgetPackages } from "../board-objects/widget-runtime";
import { useToolPackages } from "../tiles/tool-plugins";
import { useCommunityReport } from "../workspace/views/community/registry";
import { rescan } from "../settings-views";
import { cleanError } from "./catalog-install";
import { PluginRow, type ListedRow } from "./PluginList";
import { MemberIcon, MEMBER_KIND, RUNS_LABEL } from "./PackageReview";
import { packageRows, type PackageRow } from "./package-rows";
import { takeOpeningPackage } from "./scope";
import type { InstalledPackageInfo } from "../../../shared/ipc";

/** The installed packages, read again when the window comes back and after a change. */
function useInstalledPackages(): [InstalledPackageInfo[], () => void] {
  const [list, setList] = useState<InstalledPackageInfo[]>([]);
  const load = useCallback(() => { void window.hive.installedPackages?.().then(setList, () => setList([])); }, []);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    const offWidgets = window.hive.onWidgetsChanged(load);
    const offTools = window.hive.onToolsChanged(load);
    return () => { window.removeEventListener("focus", load); offWidgets(); offTools(); };
  }, [load]);
  return [list, load];
}

/** The Packages tab's rows. */
export function usePackageRows(matches: (text: string) => boolean): ListedRow[] {
  const [packages, reload] = useInstalledPackages();
  const state = useSettings().plugins.state;
  const widgets = useWidgetPackages();
  const tools = useToolPackages().packages;
  const views = useCommunityReport().packages;
  const [open, setOpen] = useState<string | null>(takeOpeningPackage);
  const nameOf = (kind: string, id: string) =>
    kind === "widget" ? widgets.find((w) => w.id === id)?.name
    : kind === "tool" ? tools.find((t) => t.id === id)?.name
    : kind === "view" ? views.find((v) => v.id === id)?.manifest?.name : undefined;
  return packageRows(packages, state, nameOf, matches).map((p) => ({
    key: `package:${p.id}`, kind: "package", category: "other",
    row: <PackageItem p={p} open={open === p.id} toggle={() => setOpen(open === p.id ? null : p.id)} reload={() => { reload(); rescan(); }} />,
  }));
}

function PackageItem({ p, open, toggle, reload }: { p: PackageRow; open: boolean; toggle: () => void; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    setError(null); setBusy(true);
    try { await fn(); setAsking(false); } catch (e) { setError(cleanError(e)); } finally { setBusy(false); reload(); }
  };
  const Chevron = open ? ChevronDown : ChevronRight;
  const offAlone = p.on ? p.members.filter((m) => !m.on).length : 0;
  return <div className="package-item" data-package={p.id} data-open={open ? "" : undefined}>
    <div className="plugin-row" data-state={p.on ? "on" : "off"}>
      <button type="button" className="package-toggle" aria-expanded={open} aria-controls={`package-${p.id}`} onClick={toggle} data-package-open={p.id}>
        <Chevron size={15} className="plugin-row-mark" />
        <span className="plugin-row-text">
          <span className="plugin-row-name">{p.name}</span>
          <span className="plugin-row-detail">{p.members.length} plugins · {p.version}{offAlone ? ` · ${offAlone} switched off` : ""}</span>
        </span>
      </button>
      <Switch aria-label={`Switch ${p.name} ${p.on ? "off" : "on"}`} checked={p.on} data-package-switch={p.id}
        onCheckedChange={(on) => { toast.dismiss(`package:${p.id}`); void act(() => window.hive.switchPackage(p.id, on)); }} />
    </div>
    {error && <p role="alert" className="settings-note error">{error}</p>}
    {open && <div id={`package-${p.id}`} className="package-members" data-package-members={p.id}>
      {p.members.map((m) => {
        const detail = `${MEMBER_KIND[m.kind] ?? m.kind} · ${RUNS_LABEL[m.runs] ?? m.runs}`;
        return m.own
          ? <PluginRow key={`${m.kind}:${m.id}`} kind={m.own.kind} id={m.id} name={m.name} mark={<MemberIcon kind={m.kind} size={14} />}
            line={p.on ? detail : `${detail} · off with ${p.name}`} state={m.on ? "on" : "off"}
            action={<Switch aria-label={`Switch ${m.name} ${m.on ? "off" : "on"}`} checked={m.on} disabled={!m.on && !m.own.canTurnOn} data-member-switch={`${m.kind}:${m.id}`}
              onCheckedChange={(on) => void act(() => window.hive.switchPlugin(m.own!.kind, m.id, on))} />} />
          : <div key={`${m.kind}:${m.id}`} className="plugin-row" data-state={m.on ? "on" : "off"} data-plugin-row={`${m.kind}:${m.id}`}>
            <span className="plugin-row-mark" aria-hidden="true"><MemberIcon kind={m.kind} size={14} /></span>
            <span className="plugin-row-text"><span className="plugin-row-name">{m.name}</span>
              <span className="plugin-row-detail">{detail} · on and off with {p.name}</span></span>
          </div>;
      })}
      {p.previous && (asking
        ? <div className="settings-remove-confirm package-rollback" data-rollback-confirm={p.id}>
          <p>Go back to {p.previous.version}? It comes back {p.previous.on ? "on" : "off"}, as it was. {p.version} is kept.</p>
          <div className="settings-actions">
            <Button variant="outline" disabled={busy} onClick={() => setAsking(false)}>Keep {p.version}</Button>
            <Button disabled={busy} data-rollback-do={p.id} onClick={() => void act(() => window.hive.rollbackPackage(p.id))}>{busy ? "Rolling back…" : `Roll back to ${p.previous.version}`}</Button>
          </div>
        </div>
        : <Button variant="ghost" size="sm" className="package-rollback-open" data-rollback={p.id} onClick={() => setAsking(true)}><History />Roll back to {p.previous.version}</Button>)}
    </div>}
  </div>;
}
