/**
 * Settings ▸ Plugins: every plugin of every kind on one page, the ones you have or the ones on
 * HiveHub, found by one search and one kind filter in one row of controls. Each kind is a group of
 * rows alike; a row opens the plugin's page, where it is set up, switched off or removed.
 */
import { useEffect, useState } from "react";
import { FolderPlus, Sparkles } from "../components/icons";
import { isPluginEnabled } from "@hivemind/core/plugin-settings";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useSettings } from "../settings-store";
import { useWidgetPackages } from "../board-objects/widget-runtime";
import { SETTINGS_PAGES } from "../settings-registry";
import { AgentsSection } from "../settings-agents";
import { ViewsSection, rescan } from "../settings-views";
import { ToolsSection } from "../settings-tools";
import { BrowsePlugins, cleanError, type Preview } from "../settings-plugins";
import { KIND_LABEL, PLUGIN_KINDS, type PluginKind } from "./library";
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
  // Read again whenever the window comes back: a plugin added from a terminal shows up.
  useEffect(() => {
    rescan();
    window.addEventListener("focus", rescan);
    return () => window.removeEventListener("focus", rescan);
  }, []);
  return <div className="settings-stack" data-plugins-home>
    <div className="plugins-lead">
      <p>{SETTINGS_PAGES.find((p) => p.id === "plugins")!.description}</p>
      {/* Not on HiveHub nor here: an agent makes it. */}
      <Button variant="outline" data-make-plugin-open onClick={() => window.dispatchEvent(new CustomEvent("hivemind:make-plugin", { detail: { kind: kind === "tool" || kind === "view" ? kind : "widget" } }))}><Sparkles />Make your own</Button>
    </div>
    <div className="plugins-controls" data-plugins-controls>
      <div role="tablist" aria-label="Show" className="plugins-scope">
        {SCOPES.map(([s, label]) => <button key={s} type="button" role="tab" aria-selected={scope === s} data-plugins-scope={s} onClick={() => setScope(s)}>{label}</button>)}
      </div>
      <Input type="search" placeholder="Search plugins" aria-label="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} className="flex-1 min-w-[140px]" />
      <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as "all" | PluginKind)}>
        <option value="all">All kinds</option>
        {PLUGIN_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}s</option>)}
      </select>
    </div>
    {scope === "hub"
      ? <BrowsePlugins query={query} kind={kind} />
      : <>
        {show("agent") && <AgentsSection matches={matches} />}
        {show("view") && <ViewsSection matches={matches} />}
        {show("widget") && <WidgetsSection matches={matches} />}
        {show("tool") && <ToolsSection matches={matches} />}
        <p className="settings-empty plugins-none">Nothing you have matches. <button type="button" className="settings-link" onClick={() => setScope("hub")}>Look on HiveHub</button></p>
        <AddFromFolder />
        <p className="settings-note">More on HiveHub: <button type="button" className="settings-link" onClick={() => setScope("hub")}>browse what others published</button>.</p>
      </>}
  </div>;
}

/** The widgets you have; one that is off is not offered and does not run. */
function WidgetsSection({ matches }: { matches: (text: string) => boolean }) {
  const widgets = useWidgetPackages().filter((w) => matches(`${w.name} ${w.id} ${w.description ?? ""}`));
  const state = useSettings().plugins.state;
  if (!widgets.length) return null;
  return <PluginGroup kind="widget" count={widgets.length}>
    {widgets.map((w) => {
      const on = isPluginEnabled(state, "widget", w.id);
      return <PluginRow key={w.id} kind="widget" id={w.id} name={w.name} mark={<WidgetIcon pkg={w} />}
        line={w.description || (w.builtin ? "Comes with the app" : "You added this")} state={on ? "on" : "off"} badge={on ? undefined : "Off"} />;
    })}
  </PluginGroup>;
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
  // Added from a folder this computer's picker chooses: not from a browser tab.
  const { previewViewInstall, installWidget, installToolPackage } = window.hive;
  return <>
    <div className="plugins-from-folder" data-add-from-folder>
      {previewViewInstall && <Button variant="ghost" disabled={busy} onClick={() => void act(async () => setPreview(await previewViewInstall()))}><FolderPlus />Add a view from a folder</Button>}
      {installWidget && <Button variant="ghost" disabled={busy} data-widget-install onClick={() => void act(async () => {
        const added = await installWidget();
        if (added) setNotice(`${added.name} added. Put it in a workspace with + on the toolbar.`);
      })}><FolderPlus />Add a widget from a folder</Button>}
      {installToolPackage && <Button variant="ghost" disabled={busy} data-tool-install onClick={() => void act(async () => {
        const added = await installToolPackage();
        if (added) setNotice(`${added.name} added. It is off: open it to switch it on if you trust who wrote it.`);
      })}><FolderPlus />Add a tool from a folder</Button>}
    </div>
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
}
