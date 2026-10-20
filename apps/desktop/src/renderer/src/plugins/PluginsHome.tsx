/**
 * Settings ▸ Plugins: every plugin of every kind on one page, the ones you have or the ones on
 * HiveHub, found by one search and one kind filter in one row of controls. Each kind is a group of
 * rows alike; a row opens the plugin's page, where it is set up, switched off or removed. Adding
 * one that is not on HiveHub, made by an agent or from a folder, is one menu at the top.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, FolderPlus, Plus, Sparkles } from "../components/icons";
import { isPluginOn } from "@hivemind/core/plugin-settings";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useSettings } from "../settings-store";
import { useWidgetPackages } from "../board-objects/widget-runtime";
import { SETTINGS_PAGES } from "../settings-registry";
import { AgentsSection } from "../settings-agents";
import { ViewsSection, rescan } from "../settings-views";
import { ToolsSection } from "../settings-tools";
import { BrowsePlugins, cleanError, type Preview } from "../settings-plugins";
import { KIND_LABEL, PLUGIN_KINDS, useHubDescription, type PluginKind } from "./library";
import { PluginGroup, PluginRow } from "./PluginList";
import { WidgetIcon } from "./WidgetIcon";
import { pluginsScope, setPluginsScope, type PluginsScope } from "./scope";

const SCOPES: [PluginsScope, string][] = [["installed", "Installed"], ["hub", "HiveHub"]];

export function PluginsHome() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | PluginKind>("all");
  const [scope, setScopeState] = useState<PluginsScope>(pluginsScope);
  const setScope = (s: PluginsScope) => { setScopeState(s); setPluginsScope(s); };
  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const show = (k: PluginKind) => kind === "all" || kind === k;
  const fromFolder = useAddFromFolder();
  // Read again whenever the window comes back: a plugin added from a terminal shows up.
  useEffect(() => {
    rescan();
    window.addEventListener("focus", rescan);
    return () => window.removeEventListener("focus", rescan);
  }, []);
  return <div className="settings-stack" data-plugins-home>
    <div className="plugins-lead">
      <p>{SETTINGS_PAGES.find((p) => p.id === "plugins")!.description}</p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" disabled={fromFolder.busy} data-add-plugin><Plus />Add<ChevronDown /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {/* Not on HiveHub nor here: an agent makes it. */}
          <DropdownMenuItem data-make-plugin-open onSelect={() => window.dispatchEvent(new CustomEvent("hivemind:make-plugin", { detail: { kind: kind === "tool" || kind === "view" ? kind : "widget" } }))}><Sparkles />Make your own</DropdownMenuItem>
          {fromFolder.items.length > 0 && <DropdownMenuSeparator />}
          {fromFolder.items}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <div className="plugins-controls" data-plugins-controls>
      <div role="tablist" aria-label="Show" className="plugins-scope">
        {SCOPES.map(([s, label]) => <button key={s} type="button" role="tab" aria-selected={scope === s} data-plugins-scope={s} onClick={() => setScope(s)}>{label}</button>)}
      </div>
      <Input type="search" placeholder="Search plugins" aria-label="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} className="flex-1 min-w-[140px]" />
      <Select value={kind} onValueChange={(v) => setKind(v as "all" | PluginKind)}>
        <SelectTrigger aria-label="Kind" className="min-w-32"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All kinds</SelectItem>
          {PLUGIN_KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}s</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    {fromFolder.panel}
    {scope === "hub"
      ? <BrowsePlugins query={query} kind={kind} />
      : <>
        {show("agent") && <AgentsSection matches={matches} />}
        {show("view") && <ViewsSection matches={matches} />}
        {show("widget") && <WidgetsSection matches={matches} />}
        {show("tool") && <ToolsSection matches={matches} />}
        <p className="settings-empty plugins-none">Nothing you have matches. <button type="button" className="settings-link" onClick={() => setScope("hub")}>Look on HiveHub</button></p>
      </>}
  </div>;
}

/** The widgets you have; one that is off is not offered and does not run. */
function WidgetsSection({ matches }: { matches: (text: string) => boolean }) {
  const widgets = useWidgetPackages().filter((w) => matches(`${w.name} ${w.id} ${w.description ?? ""}`));
  const state = useSettings().plugins.state;
  const hub = useHubDescription();
  if (!widgets.length) return null;
  return <PluginGroup kind="widget" count={widgets.length}>
    {widgets.map((w) => {
      const on = isPluginOn(state, "widget", w);
      return <PluginRow key={w.id} kind="widget" id={w.id} name={w.name} mark={<WidgetIcon pkg={w} />}
        line={w.description || hub("widget", w.id)} state={on ? "on" : "off"} badge={on ? undefined : "Off"} />;
    })}
  </PluginGroup>;
}

/** Adding a view, a widget or a tool from a folder on this computer: the Add menu's items, and
 *  what they say after. A view is reviewed first. An agent from a folder is
 *  `hive agents install <folder>`. */
function useAddFromFolder(): { items: ReactNode[]; panel: ReactNode; busy: boolean } {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(cleanError(e)); } finally { setBusy(false); }
  };
  // Added from a folder this computer's picker chooses: not from a browser tab.
  const { previewViewInstall, installWidget, installToolPackage } = window.hive;
  const items = [
    previewViewInstall && <DropdownMenuItem key="view" data-view-install onSelect={() => void act(async () => setPreview(await previewViewInstall()))}><FolderPlus />Add a view from a folder</DropdownMenuItem>,
    installWidget && <DropdownMenuItem key="widget" data-widget-install onSelect={() => void act(async () => {
      const added = await installWidget();
      if (added) setNotice(`${added.name} added. Put it in a workspace with + on the toolbar.`);
    })}><FolderPlus />Add a widget from a folder</DropdownMenuItem>,
    installToolPackage && <DropdownMenuItem key="tool" data-tool-install onSelect={() => void act(async () => {
      const added = await installToolPackage();
      if (added) setNotice(`${added.name} added. It is off: open it to switch it on if you trust who wrote it.`);
    })}><FolderPlus />Add a tool from a folder</DropdownMenuItem>,
  ].filter(Boolean);
  const panel = <>
    {error && <div role="alert" className="settings-message error">{error}</div>}
    {notice && <div role="status" className="settings-message">{notice}</div>}
    {preview && <section className="settings-install-review" aria-label="Review extension">
      <div className="settings-section-heading"><h3>Review installation</h3><span>{preview.package.manifest?.name} · {preview.package.manifest?.version}</span></div>
      <p>This view can display workspace names and agent status, and open your existing tools.</p>
      <p>{preview.package.manifest?.permissions.length ? `Additional access: ${preview.package.manifest.permissions.join(", ")}` : "No additional access requested."}</p>
      {preview.replacesVersion && <p className="settings-note">Replaces installed version {preview.replacesVersion}. Your saved layout is kept.</p>}
      <div className="settings-actions"><Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>Cancel</Button><Button disabled={busy} onClick={() => void act(async () => {
        await window.hive.installViewPackage(preview.token);
        setNotice(`${preview.package.manifest?.name} installed. Choose it under Views when you’re ready.`); setPreview(null); rescan();
      })}>{busy ? "Installing…" : preview.replacesVersion ? "Replace extension" : "Install extension"}</Button></div>
    </section>}
  </>;
  return { items, panel, busy };
}
