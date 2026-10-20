/**
 * Settings ▸ Plugins: every plugin on one page, the ones you have or the ones on HiveHub, found by
 * one search, one tab per kind as HiveHub has them, then Packages. Each category, as the Add menu
 * has them, is a group of rows alike; a row opens the plugin's page, where it is set up, switched
 * off or removed. Adding one that is not on HiveHub, made by an agent or from a folder, is one
 * menu at the top; a folder is reviewed first, as `hive plugins install --dry-run` reviews it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, FolderPlus, Plus, Sparkles } from "../components/icons";
import { isPluginOn } from "@hivemind/core/plugin-settings";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useSettings } from "../settings-store";
import { useWidgetPackages } from "../board-objects/widget-runtime";
import { SETTINGS_PAGES } from "../settings-registry";
import { useAgentRows } from "../settings-agents";
import { useViewRows, rescan } from "../settings-views";
import { useToolRows } from "../settings-tools";
import { BrowsePlugins, cleanError } from "../settings-plugins";
import { useHubDescription } from "./library";
import { rowsInKindTab, type PluginTab } from "./kinds";
import { CategoryGroups, KindTabs, PluginRow, type ListedRow } from "./PluginList";
import { WidgetIcon } from "./WidgetIcon";
import { PackageReview } from "./PackageReview";
import { usePackageRows } from "./PackagesSection";
import { partOfPackage } from "./package-rows";
import { pluginsScope, pluginsTab, setPluginsScope, setPluginsTab, type PluginsScope } from "./scope";
import type { PackageReview as Review } from "../../../shared/ipc";

const SCOPES: [PluginsScope, string][] = [["installed", "Installed"], ["hub", "HiveHub"]];

export function PluginsHome() {
  const [query, setQuery] = useState("");
  const [tab, setTabState] = useState<PluginTab>(pluginsTab);
  const setTab = (t: PluginTab) => { setTabState(t); setPluginsTab(t); };
  const [scope, setScopeState] = useState<PluginsScope>(pluginsScope);
  const setScope = (s: PluginsScope) => { setScopeState(s); setPluginsScope(s); };
  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
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
          <DropdownMenuItem data-make-plugin-open onSelect={() => window.dispatchEvent(new CustomEvent("hivemind:make-plugin", { detail: { kind: tab === "tool" || tab === "view" ? tab : "widget" } }))}><Sparkles />Make your own</DropdownMenuItem>
          {fromFolder.item && <><DropdownMenuSeparator />{fromFolder.item}</>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <div className="plugins-controls" data-plugins-controls>
      <div role="tablist" aria-label="Show" className="plugins-scope">
        {SCOPES.map(([s, label]) => <button key={s} type="button" role="tab" aria-selected={scope === s} data-plugins-scope={s} onClick={() => setScope(s)}>{label}</button>)}
      </div>
      <Input type="search" placeholder="Search plugins" aria-label="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} className="flex-1 min-w-[140px]" />
    </div>
    {fromFolder.panel}
    {scope === "hub"
      ? <BrowsePlugins query={query} tab={tab} onTab={setTab} />
      : <>
        <InstalledPlugins matches={matches} tab={tab} onTab={setTab} />
        <p className="settings-empty plugins-none">{tab === "package" && !q
          ? "No package holding several plugins is installed."
          : <>Nothing you have matches. <button type="button" className="settings-link" onClick={() => setScope("hub")}>Look on HiveHub</button></>}</p>
      </>}
  </div>;
}

/** The plugins you have, the open tab's kind under its categories, or the packages. */
function InstalledPlugins({ matches, tab, onTab }: { matches: (text: string) => boolean; tab: PluginTab; onTab: (tab: PluginTab) => void }) {
  const agents = useAgentRows(matches);
  const views = useViewRows(matches);
  const widgets = useWidgetRows(matches);
  const tools = useToolRows(matches);
  const packages = usePackageRows(matches);
  const { counts, groups } = rowsInKindTab([...agents.rows, ...views, ...widgets, ...tools.rows, ...packages], tab);
  return <>
    <KindTabs counts={counts} tab={tab} onChange={onTab} />
    {tab === "tool" && tools.warning && <p role="status" className="settings-message">{tools.warning}</p>}
    <CategoryGroups groups={groups} feet={tab === "agent" && agents.foot ? { agents: agents.foot } : {}} />
    {tab === "view" && views.length > 0 && <p className="settings-note">⌘E switches between the views that are on.</p>}
  </>;
}

/** The widgets you have, each under its category; one that is off is not offered and does not run. */
function useWidgetRows(matches: (text: string) => boolean): ListedRow[] {
  const widgets = useWidgetPackages().filter((w) => matches(`${w.name} ${w.id} ${w.description ?? ""}`));
  const state = useSettings().plugins.state;
  const hub = useHubDescription();
  return widgets.map((w) => {
    const on = isPluginOn(state, "widget", w);
    const part = partOfPackage(w);
    return { key: `widget:${w.id}`, kind: "widget", category: w.category ?? "other",
      row: <PluginRow kind="widget" id={w.id} name={w.name} mark={<WidgetIcon pkg={w} />}
        line={part ? `Part of ${part.name}` : w.description || hub("widget", w.id)} state={on ? "on" : "off"} badge={on ? undefined : "Off"} /> };
  });
}

/** Adding a package, or one plugin, from a folder on this computer: the Add menu's item, then the
 *  review of what it holds and, for one installed already, what changes. An agent from a folder
 *  is `hive agents install <folder>`. */
function useAddFromFolder(): { item: ReactNode; panel: ReactNode; busy: boolean } {
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ref = useRef<HTMLElement | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(cleanError(e)); } finally { setBusy(false); }
  };
  // From a folder this computer's picker chooses: not from a browser tab.
  const { reviewPackageFolder, installPackageFolder } = window.hive;
  const item = reviewPackageFolder && <DropdownMenuItem data-folder-install onSelect={() => void act(async () => {
    setReview(null);
    const r = await reviewPackageFolder();
    setReview(r);
    if (r) requestAnimationFrame(() => ref.current?.focus());
  })}><FolderPlus />Add from a folder</DropdownMenuItem>;
  const panel = <>
    {error && <div role="alert" className="settings-message error">{error}</div>}
    {notice && <div role="status" className="settings-message">{notice}</div>}
    {review && installPackageFolder && <section ref={ref} tabIndex={-1} className="settings-install-review" aria-label={`Review ${review.name}`}>
      <PackageReview review={review} heading />
      <div className="settings-actions"><Button variant="outline" disabled={busy} onClick={() => setReview(null)}>Cancel</Button><Button disabled={busy} data-folder-install-do onClick={() => void act(async () => {
        await installPackageFolder(review.token);
        setNotice(`${review.name} ${review.version} is installed${review.on ? "" : ", switched off"}.`); setReview(null); rescan();
      })}>{busy ? "Installing…" : review.replaces ? "Update" : "Install"}</Button></div>
    </section>}
  </>;
  return { item, panel, busy };
}
