import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ExternalLink, Puzzle, Store, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button";
import { MenuItem } from "./components/ui/menu-item";
import { Switch } from "./components/ui/switch";
import { getSettings, patchSettings, useSettings } from "./settings-store";
import { getView, resolveChrome, resolveViewId, useViews } from "./workspace/workspace-view";
import { setViewMode, useViewMode } from "./workspace/view-mode-store";
import type { IslandPlacement } from "@hivemind/core/settings-schema";
import { BUILTIN_TOOLBAR_ACTIONS, resolveToolbar, type ToolbarActionId, type ToolbarPreferences } from "@hivemind/core/toolbar";
import { useCommunityReport } from "./workspace/views/community/registry";
import { useSettingsNavigate } from "./settings-panels";

export const rescan = () => { window.dispatchEvent(new CustomEvent("hivemind:reload-views")); };

export function PackageRow({ icon, title, subtitle, enabled, onToggle, toggleDisabled, testAttr, children, footer }: {
  icon?: React.ReactNode;
  title: string;
  subtitle: React.ReactNode;
  enabled: boolean;
  onToggle: () => void;
  toggleDisabled?: boolean;
  /** e.g. `{ "data-community-pkg": id }` — the hooks e2e specs pin. */
  testAttr?: Record<string, string>;
  /** Rendered inside the row, before the switch. */
  children?: React.ReactNode;
  /** Rendered under the row, inside the container: problems, disclosures. */
  footer?: React.ReactNode;
}) {
  return <div className="settings-extension" {...testAttr}>
    <div className="settings-extension-row">
      <div className="settings-extension-icon">{icon ?? <Puzzle size={19} />}</div>
      <div className="settings-extension-label"><h4>{title}</h4><p>{subtitle}</p></div>
      {children}
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        aria-label={`Enable ${title}`}
        disabled={toggleDisabled}
      />
    </div>
    {footer}
  </div>;
}
export function ViewsOverview() {
  const views = useViews();
  const go = useSettingsNavigate();
  const mode = resolveViewId(useViewMode()) ?? "canvas";
  const disabled = useSettings().plugins.disabled;
  useEffect(rescan, []);
  const on = views.filter((v) => !disabled.includes(v.id));
  const off = views.filter((v) => disabled.includes(v.id));
  const row = (view: ReturnType<typeof useViews>[number], choosable: boolean) => (
    <div key={view.id} className="plugin-row" data-view-row={view.id} data-state={choosable ? (mode === view.id ? "on" : "ready") : "off"}>
      <MenuItem className="flex-1 min-w-0" onClick={() => go(`view:${view.id}`)}>
        <span className="plugin-row-mark" aria-hidden="true"><view.icon /></span>
        <span className="plugin-row-text">
          <span className="plugin-row-name">{view.label}</span>
          <span className="plugin-row-detail">{view.hint}</span>
        </span>
      </MenuItem>
      {choosable && (
        <Button size="xs" variant={mode === view.id ? "secondary" : "outline"} data-view-choice={view.id} role="radio" aria-checked={mode === view.id}
          aria-label={mode === view.id ? `${view.label} is in use` : `Use ${view.label}`} title="Workspace view"
          onClick={() => setViewMode(view.id)}>{mode === view.id ? "In use" : <span className="plugin-choice-dot" aria-hidden="true" />}</Button>
      )}
      <ChevronRight className="plugin-row-go" size={15} aria-hidden="true" />
    </div>
  );
  return <div className="settings-stack">
    <section aria-label="Workspace view">
      <div className="settings-section-heading"><h3>Workspace view · {on.length}</h3><span>⌘E cycles through them</span></div>
      <div className="plugin-rows" role="radiogroup" aria-label="Workspace view">{on.map((v) => row(v, true))}</div>
    </section>
    {off.length > 0 && <section aria-label="Off">
      <div className="settings-section-heading"><h3>Off · {off.length}</h3><span>Open one to switch it back on</span></div>
      <div className="plugin-rows">{off.map((v) => row(v, false))}</div>
    </section>}
    <div className="settings-inline">
      <Button size="sm" variant="outline" onClick={() => go("plugins")}><Store />Browse views</Button>
      <Button size="sm" variant="link" onClick={() => go("installed")}><Puzzle />Add one from a folder</Button>
    </div>
  </div>;
}

export function ViewPage({ id }: { id: string }) {
  const view = getView(id);
  const mode = resolveViewId(useViewMode()) ?? "canvas";
  const settings = useSettings();
  const report = useCommunityReport();
  const go = useSettingsNavigate();
  useEffect(rescan, []);
  // Every hook runs first: switching this view off unregisters it while the page is still mounted.
  if (!view) return <p className="settings-empty">There is no view named {id}.</p>;
  const pkg = report.packages.find((p) => p.id === id);
  const override = settings.views.chrome[id]?.island;
  const on = !settings.plugins.disabled.includes(id);
  return <div className="plugin-page" data-view-page={id}>
    <header className="plugin-head">
      <span className="plugin-mark"><view.icon size={22} /></span>
      <div className="plugin-title"><p>{view.hint}<span>·</span>{view.source === "community" ? `Community${pkg?.manifest?.version ? ` · ${pkg.manifest.version}` : ""}` : "Included with Hivemind"}</p></div>
      {mode === id ? <span className="agent-badge">In use</span> : <Button size="sm" variant="outline" onClick={() => setViewMode(id)}>Use this view</Button>}
      {view.source === "community" && <Switch aria-label={`Enable ${view.label}`} checked={on}
        onCheckedChange={() => { const d = getSettings().plugins.disabled; patchSettings("plugins.disabled", on ? [...new Set([...d, id])] : d.filter((x) => x !== id)); rescan(); }} />}
    </header>
    <section className="plugin-section" aria-label="Toolbar">
      <h3>Toolbar</h3>
      <div className="settings-row">
        <div><label htmlFor="toolbar-position">Display</label><p>Use the view’s default or choose a position.</p></div>
        <select id="toolbar-position" value={override ?? "auto"} onChange={(e) => {
          const chrome = { ...getSettings().views.chrome };
          if (e.target.value === "auto") delete chrome[id];
          else chrome[id] = { island: e.target.value as IslandPlacement };
          patchSettings("views.chrome", chrome);
        }}>
          <option value="auto">Automatic ({resolveChrome(view).island})</option>
          <option value="top">Top</option><option value="bottom">Bottom</option><option value="hidden">Collapsed</option><option value="off">Off</option>
        </select>
      </div>
      {override === "hidden" && <p className="settings-note">Show a handle to expand the toolbar.</p>}
      {override === "off" && <p className="settings-note">Shortcuts and custom view controls remain available.</p>}
      <ToolbarSettings mode={id} />
    </section>
    {pkg && <section className="plugin-section" aria-label="Details">
      <h3>Details</h3>
      <dl>
        {/* The package's own claim about who wrote it — nobody has checked it, and the wording
            says so, so it is never mistaken for a registry's verified owner. */}
        <dt>Says it is by</dt>
        <dd>{pkg.manifest?.author ?? "Not stated"}{pkg.manifest?.license ? ` · ${pkg.manifest.license}` : ""}{pkg.manifest?.homepage && <> · <a href={pkg.manifest.homepage} target="_blank" rel="noreferrer">Source<ExternalLink size={11} /></a></>}</dd>
        <dt>Available to</dt><dd>{pkg.source === "user" ? "All your workspaces" : "This repository"}</dd>
        <dt>Location</dt><dd className="settings-path">{pkg.dir}</dd>
        <dt>Additional access</dt><dd>{pkg.manifest?.permissions.join(", ") || "None"}</dd>
      </dl>
      {pkg.source === "user" && <RemoveView id={id} name={view.label} onRemoved={() => go("views")} />}
    </section>}
  </div>;
}

function RemoveView({ id, name, onRemoved }: { id: string; name: string; onRemoved: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!confirm) return <Button variant="destructive" size="sm" className="mt-3" onClick={() => setConfirm(true)}><Trash2 />Remove {name}</Button>;
  return <div className="settings-remove-confirm">
    <p>Remove {name}? Its saved layout is kept, and your work keeps running.</p>
    {error && <p role="alert" className="settings-note error">{error}</p>}
    <div className="settings-actions">
      <Button size="sm" variant="outline" onClick={() => setConfirm(false)}>Keep it</Button>
      <Button size="sm" variant="destructive" onClick={() => void window.hive.removeViewPackage(id).then(() => { rescan(); onRemoved(); }, (e: Error) => setError(e.message))}>Remove</Button>
    </div>
  </div>;
}

function ToolbarSettings({ mode }: { mode: string }) {
  const settings = useSettings();
  const preference = settings.views.toolbars[mode];
  const actions = resolveToolbar(preference);
  const selected = actions.map((action) => action.id);
  const rows = [...actions, ...BUILTIN_TOOLBAR_ACTIONS.filter((action) => !selected.includes(action.id))];
  const update = (patch: Partial<ToolbarPreferences>) => {
    const current = getSettings().views.toolbars;
    patchSettings("views.toolbars", { ...current, [mode]: { ...current[mode], ...patch } });
  };
  const move = (id: ToolbarActionId, direction: -1 | 1) => {
    const next = [...selected];
    const index = next.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    update({ actions: next });
  };
  return <details className="settings-toolbar-customize">
    <summary>Customize actions <ChevronDown size={14} /></summary>
    <p className="settings-note">Choose the buttons and their order. Enable tools under Tools.</p>
    <div className="settings-row">
      <label><input type="checkbox" checked={preference?.labels ?? false} onChange={(event) => update({ labels: event.target.checked })} /> Show labels</label>
      <Button size="sm" variant="outline" onClick={() => {
        const current = { ...getSettings().views.toolbars };
        delete current[mode];
        patchSettings("views.toolbars", current);
      }}>Reset actions</Button>
    </div>
    <ol className="settings-toolbar-actions" aria-label="Toolbar actions">
      {rows.map((action) => {
        const index = selected.indexOf(action.id);
        return <li key={action.id} data-toolbar-setting={action.id}>
          <label><input type="checkbox" checked={index >= 0} onChange={(event) => update({ actions: event.target.checked ? [...selected, action.id] : selected.filter((id) => id !== action.id) })} />{action.label}</label>
          <Button variant="ghost" size="icon-sm" aria-label={`Move ${action.label} up`} disabled={index <= 0} onClick={() => move(action.id, -1)}><ArrowUp /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Move ${action.label} down`} disabled={index < 0 || index === selected.length - 1} onClick={() => move(action.id, 1)}><ArrowDown /></Button>
        </li>;
      })}
    </ol>
    {selected.length === 0 && <p className="settings-note">No toolbar actions selected. Settings and custom view controls remain available.</p>}
  </details>;
}
