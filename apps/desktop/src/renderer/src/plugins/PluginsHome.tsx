/**
 * Settings ▸ Plugins: every plugin of every kind on one page, the ones you have and the ones on
 * HiveHub, found by one search and one kind filter. A plugin's name opens its page (its settings,
 * its README, what it can do). The per-kind sections keep what each kind decides here: the
 * default agent, the view in use, a tool or widget switched on or off.
 */
import { useEffect, useState } from "react";
import { ChevronRight, FolderPlus, RefreshCw, Sparkles, Trash } from "lucide-react";
import { isPluginEnabled } from "@hivemind/core/plugin-settings";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { MenuItem } from "../components/ui/menu-item";
import { setPluginEnabled, useSettings } from "../settings-store";
import { useWidgetPackages } from "../board-objects/widget-runtime";
import { AgentsSection } from "../settings-agents";
import { ViewsSection, rescan } from "../settings-views";
import { ToolsSection } from "../settings-tools";
import { BrowsePlugins, cleanError, type Preview } from "../settings-plugins";
import { useSettingsNavigate } from "../settings-panels";
import { KIND_LABEL, PLUGIN_KINDS, type PluginKind } from "./library";
import { WidgetIcon } from "./WidgetIcon";
import { pluginsScope, setPluginsScope, type PluginsScope } from "./scope";

export function PluginsHome() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | PluginKind>("all");
  const [scope, setScopeState] = useState<PluginsScope>(pluginsScope);
  const setScope = (s: PluginsScope) => { setScopeState(s); setPluginsScope(s); };
  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const show = (k: PluginKind) => kind === "all" || kind === k;
  useEffect(rescan, []);
  return <div className="settings-stack" data-plugins-home>
    <div className="catalog-bar">
      <div className="catalog-filters" role="group" aria-label="Where">
        <Button size="sm" variant={scope === "installed" ? "secondary" : "outline"} aria-pressed={scope === "installed"} onClick={() => setScope("installed")}>Yours</Button>
        <Button size="sm" variant={scope === "hub" ? "secondary" : "outline"} aria-pressed={scope === "hub"} data-plugins-scope="hub" onClick={() => setScope("hub")}>On HiveHub</Button>
      </div>
      <Input type="search" placeholder="Search plugins" aria-label="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} className="flex-1 min-w-[160px]" />
      {/* Not on HiveHub nor here: an agent makes it. */}
      <Button size="sm" data-make-plugin-open onClick={() => window.dispatchEvent(new CustomEvent("hivemind:make-plugin", { detail: { kind: kind === "tool" || kind === "view" ? kind : "widget" } }))}><Sparkles />Make your own</Button>
    </div>
    <div className="catalog-filters" role="group" aria-label="Plugin type">
      {(["all", ...PLUGIN_KINDS] as const).map((k) => (
        <Button key={k} size="sm" variant={kind === k ? "secondary" : "ghost"} aria-pressed={kind === k} onClick={() => setKind(k)}>{k === "all" ? "All" : `${KIND_LABEL[k]}s`}</Button>
      ))}
    </div>
    {scope === "hub"
      ? <BrowsePlugins query={query} kind={kind} />
      : <>
        <AddFromFolder />
        {show("agent") && <AgentsSection matches={matches} />}
        {show("view") && <ViewsSection matches={matches} />}
        {show("widget") && <WidgetsSection matches={matches} />}
        {show("tool") && <ToolsSection matches={matches} />}
        <p className="settings-note">More on HiveHub: <button type="button" className="settings-link" onClick={() => setScope("hub")}>browse what others published</button>.</p>
      </>}
  </div>;
}

/** The widgets you have: each one switched on or off (one off is not offered and does not run), and
 *  one you added removed. */
function WidgetsSection({ matches }: { matches: (text: string) => boolean }) {
  const widgets = useWidgetPackages().filter((w) => matches(`${w.name} ${w.id} ${w.description ?? ""}`));
  const state = useSettings().plugins.state;
  const go = useSettingsNavigate();
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!widgets.length) return null;
  return <section className="settings-stack plugins-kind" aria-label="Widgets" data-plugins-kind="widget">
    <h3 className="plugins-kind-heading">Widgets</h3>
    {error && <p role="alert" className="settings-note error">{error}</p>}
    <div className="plugin-rows">
      {widgets.map((w) => {
        const on = isPluginEnabled(state, "widget", w.id);
        return <div key={w.id} className="plugin-row" data-widget-package={w.id} data-state={on ? "on" : "off"}>
          <MenuItem className="flex-1 min-w-0" data-plugin-open={`widget:${w.id}`} onClick={() => go(`plugin:widget:${w.id}`)}>
            <span className="plugin-row-mark" aria-hidden="true"><WidgetIcon pkg={w} /></span>
            <span className="plugin-row-text">
              <span className="plugin-row-name">{w.name}</span>
              <span className="plugin-row-detail">{w.description || (w.builtin ? "Comes with the app" : "You added this")}</span>
            </span>
          </MenuItem>
          {!w.builtin && (removing === w.id
            ? <span className="settings-actions"><Button size="xs" variant="outline" onClick={() => setRemoving(null)}>Keep</Button>
              <Button size="xs" variant="destructive" onClick={() => void window.hive.removeWidget(w.id).then(() => setRemoving(null), (e) => setError(cleanError(e)))}>Remove</Button></span>
            : <Button variant="ghost" size="icon-sm" aria-label={`remove ${w.name}`} onClick={() => setRemoving(w.id)}><Trash /></Button>)}
          <Switch aria-label={`Enable ${w.name}`} checked={on} onCheckedChange={() => setPluginEnabled("widget", w.id, !on)} />
          <ChevronRight className="plugin-row-go" size={15} />
        </div>;
      })}
    </div>
  </section>;
}

/** Adding a view or a widget from a folder on this computer; a view is reviewed first. An agent
 *  from a folder is `hive agents install <folder>`. */
function AddFromFolder() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(cleanError(e)); } finally { setBusy(false); }
  };
  return <>
    <div className="settings-inline" data-add-from-folder>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => setPreview(await window.hive.previewViewInstall()))}><FolderPlus />Add a view from a folder</Button>
      <Button size="sm" variant="outline" disabled={busy} data-widget-install onClick={() => void act(async () => {
        const added = await window.hive.installWidget();
        if (added) setNotice(`${added.name} added. Put it in a workspace with + on the toolbar.`);
      })}><FolderPlus />Add a widget from a folder</Button>
      <Button size="sm" variant="outline" disabled={busy} data-tool-install onClick={() => void act(async () => {
        const added = await window.hive.installToolPackage();
        if (added) setNotice(`${added.name} added. It is off: switch it on under Tools if you trust who wrote it.`);
      })}><FolderPlus />Add a tool from a folder</Button>
      <Button variant="ghost" size="icon-sm" aria-label="Refresh plugins" onClick={rescan}><RefreshCw /></Button>
    </div>
    {error && <div role="alert" className="settings-message error">{error}</div>}
    {notice && <div role="status" className="settings-message">{notice}</div>}
    {preview && <section className="settings-install-review" aria-label="Review extension">
      <div className="settings-section-heading"><h3>Review installation</h3><span>{preview.package.manifest?.name} · {preview.package.manifest?.version}</span></div>
      <p>This view can display workspace names and agent status, and open your existing tools.</p>
      <p>{preview.package.manifest?.permissions.length ? `Additional access: ${preview.package.manifest.permissions.join(", ")}` : "No additional access requested."}</p>
      {preview.replacesVersion && <p className="settings-note">Replaces installed version {preview.replacesVersion}. Your saved layout is kept.</p>}
      <div className="settings-actions"><Button size="sm" variant="outline" disabled={busy} onClick={() => setPreview(null)}>Cancel</Button><Button size="sm" disabled={busy} onClick={() => void act(async () => {
        await window.hive.installViewPackage(preview.token);
        setNotice(`${preview.package.manifest?.name} installed. Choose it under Views when you’re ready.`); setPreview(null); rescan();
      })}>{busy ? "Installing…" : preview.replacesVersion ? "Replace extension" : "Install extension"}</Button></div>
    </section>}
  </>;
}
