import { useEffect, useState, type ReactNode } from "react";
import { isPluginEnabled } from "@hivemind/core/plugin-settings";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ExternalLink, Puzzle, Trash } from "./components/icons";
import { Button } from "./components/ui/button";
import { RowChoice } from "./plugins/RowChoice";
import { MenuItem } from "./components/ui/menu-item";
import { Switch } from "./components/ui/switch";
import { getSettings, patchSettings, useSettings, setPluginEnabled } from "./settings-store";
import { getView, resolveChrome, resolveViewId, useViews } from "./workspace/workspace-view";
import { setViewMode, useViewMode } from "./workspace/view-mode-store";
import type { IslandPlacement } from "@hivemind/core/settings-schema";
import { BUILTIN_TOOLBAR_ACTIONS, resolveToolbar, type ToolbarActionId, type ToolbarPreferences } from "@hivemind/core/toolbar";
import { useCommunityReport } from "./workspace/views/community/registry";
import { useSettingsNavigate } from "./settings-panels";

export const rescan = () => { window.dispatchEvent(new CustomEvent("hivemind:reload-views")); };

/** The views on the Plugins page: the one in use, the others to choose from, the ones off. */
export function ViewsSection({ matches }: { matches: (text: string) => boolean }) {
  const go = useSettingsNavigate();
  const mode = resolveViewId(useViewMode()) ?? "canvas";
  const report = useCommunityReport();
  useEffect(rescan, []);
  const on = useViews().filter((v) => matches(`${v.label} ${v.id} ${v.hint}`));
  // A view that is off, or cannot load, is not registered: it is listed from its package, so it
  // can be opened and switched back on.
  const off = report.packages.filter((p) => report.refused[p.id] && matches(`${p.manifest?.name ?? p.id} ${p.id}`));
  const row = (id: string, label: string, detail: string, mark: ReactNode, state: "on" | "ready" | "off" | "unavailable") => (
    <div key={id} className="plugin-row" data-view-row={id} data-state={state}>
      <MenuItem className="flex-1 min-w-0" data-plugin-open={`view:${id}`} onClick={() => go(`plugin:view:${id}`)}>
        <span className="plugin-row-mark" aria-hidden="true">{mark}</span>
        <span className="plugin-row-text">
          <span className="plugin-row-name">{label}</span>
          <span className="plugin-row-detail">{detail}</span>
        </span>
      </MenuItem>
      {(state === "on" || state === "ready") && (
        <RowChoice chosen={mode === id} said="In use" offer="Use" data-view-choice={id}
          aria-label={mode === id ? `${label} is in use` : `Use ${label}`}
          onClick={() => setViewMode(id)} />
      )}
      <ChevronRight className="plugin-row-go" size={15} />
    </div>
  );
  if (!on.length && !off.length) return null;
  return <section className="settings-stack plugins-kind" aria-label="Views" data-plugins-kind="view">
    <h3 className="plugins-kind-heading">Views</h3>
    {on.length > 0 && <section aria-label="Workspace view">
      <div className="settings-section-heading"><h3>Workspace view · {on.length}</h3><span>⌘E cycles through them</span></div>
      <div className="plugin-rows" role="radiogroup" aria-label="Workspace view">
        {on.map((v) => row(v.id, v.label, v.hint, <v.icon />, mode === v.id ? "on" : "ready"))}
      </div>
    </section>}
    {off.length > 0 && <section aria-label="Off">
      <div className="settings-section-heading"><h3>Off · {off.length}</h3><span>Open one to switch it back on</span></div>
      <div className="plugin-rows">
        {off.map((p) => {
          const why = report.refused[p.id]!;
          const switchedOff = why === "disabled in Settings";
          return row(p.id, p.manifest?.name ?? p.id, switchedOff ? `Off${p.manifest?.version ? ` · ${p.manifest.version}` : ""}` : why, <Puzzle />, switchedOff ? "off" : "unavailable");
        })}
      </div>
    </section>}
  </section>;
}

export function ViewPage({ id }: { id: string }) {
  const view = getView(id);
  const mode = resolveViewId(useViewMode()) ?? "canvas";
  const settings = useSettings();
  const report = useCommunityReport();
  const go = useSettingsNavigate();
  useEffect(rescan, []);
  // Every hook runs first: switching this view off unregisters it while the page is still mounted.
  const pkg = report.packages.find((p) => p.id === id);
  if (!view && pkg) {
    const on = isPluginEnabled(settings.plugins.state, "view", id);
    const name = pkg.manifest?.name ?? id;
    return <div className="plugin-page" data-view-page={id}>
      <div className="settings-row">
        <div className="flex-1"><label>{on ? "Cannot load" : "Off"}</label><p>{on ? report.refused[id] ?? pkg.error : "Switch it on to choose it as your workspace view."}</p></div>
        <Switch aria-label={`Enable ${name}`} checked={on} disabled={!!pkg.error} onCheckedChange={() => { setPluginEnabled("view", id, !on); rescan(); }} />
      </div>
      {pkg.source === "user" && <RemoveView id={id} name={name} onRemoved={() => go("plugins")} />}
    </div>;
  }
  if (!view) return <p className="settings-empty">There is no view named {id}.</p>;
  const override = settings.views.chrome[id]?.island;
  const on = isPluginEnabled(settings.plugins.state, "view", id);
  return <div className="plugin-page" data-view-page={id}>
    <header className="plugin-head">
      <span className="plugin-mark"><view.icon size={22} /></span>
      <div className="plugin-title"><p>{view.hint}<span>·</span>{view.source === "community" ? `Community${pkg?.manifest?.version ? ` · ${pkg.manifest.version}` : ""}` : "Included with Hivemind"}</p></div>
      {mode === id ? <span className="agent-badge">In use</span> : <Button size="sm" variant="outline" onClick={() => setViewMode(id)}>Use this view</Button>}
      {view.source === "community" && <Switch aria-label={`Enable ${view.label}`} checked={on}
        onCheckedChange={() => { setPluginEnabled("view", id, !on); rescan(); }} />}
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
        <dt>Available to</dt><dd>{pkg.source === "repo" ? "This repository" : "All your workspaces"}</dd>
        <dt>Location</dt><dd className="settings-path">{pkg.dir}</dd>
        <dt>Additional access</dt><dd>{pkg.manifest?.permissions.join(", ") || "None"}</dd>
      </dl>
      {pkg.source === "user" && <RemoveView id={id} name={view.label} onRemoved={() => go("plugins")} />}
    </section>}
  </div>;
}

function RemoveView({ id, name, onRemoved }: { id: string; name: string; onRemoved: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!confirm) return <Button variant="destructive" size="sm" className="mt-3" onClick={() => setConfirm(true)}><Trash />Remove {name}</Button>;
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
    <p className="settings-note">Choose the buttons and their order. Switch tools on under Plugins.</p>
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
