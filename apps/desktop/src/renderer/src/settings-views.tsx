import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Puzzle, Store, Trash2 } from "lucide-react";
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
      <button
        className="settings-switch"
        role="switch"
        aria-label={`Enable ${title}`}
        aria-checked={enabled}
        disabled={toggleDisabled}
        onClick={onToggle}
      ><span /></button>
    </div>
    {footer}
  </div>;
}
export function ViewsOverview() {
  const views = useViews();
  const go = useSettingsNavigate();
  const mode = resolveViewId(useViewMode()) ?? "canvas";
  useEffect(rescan, []);
  return <div className="settings-stack">
    <section aria-label="Workspace view">
      <div className="settings-section-heading"><h3>Workspace view</h3><span>⌘E cycles through them</span></div>
      <div className="settings-view-list">
        {views.map((view) => <div key={view.id} className="settings-view-row">
          <button className="settings-view-choice" aria-pressed={mode === view.id} onClick={() => setViewMode(view.id)}>
            <span className="settings-view-icon" aria-hidden="true"><view.icon size={19} /></span>
            <span className="settings-view-copy"><span className="settings-view-name">{view.label}</span><span className="settings-view-description">{view.hint}</span></span>
            <span className="settings-selection" aria-hidden="true">{mode === view.id && <Check size={15} />}</span>
          </button>
          <button className="settings-icon-button" aria-label={`${view.label} settings`} onClick={() => go(`view:${view.id}`)}><ChevronRight size={15} /></button>
        </div>)}
      </div>
      <div className="settings-inline settings-actions-left">
        <button className="settings-button" onClick={() => go("plugins")}><Store size={14} />Browse views</button>
        <button className="settings-text-button" onClick={() => go("installed")}><Puzzle size={14} />Add one from a folder</button>
      </div>
    </section>
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
      {mode === id ? <span className="agent-badge">In use</span> : <button className="settings-button" onClick={() => setViewMode(id)}>Use this view</button>}
      {view.source === "community" && <button className="settings-switch" role="switch" aria-label={`Enable ${view.label}`} aria-checked={on}
        onClick={() => { const d = getSettings().plugins.disabled; patchSettings("plugins.disabled", on ? [...new Set([...d, id])] : d.filter((x) => x !== id)); rescan(); }}><span /></button>}
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
      <dl><dt>Available to</dt><dd>{pkg.source === "user" ? "All your workspaces" : "This repository"}</dd><dt>Location</dt><dd className="settings-path">{pkg.dir}</dd><dt>Additional access</dt><dd>{pkg.manifest?.permissions.join(", ") || "None"}</dd></dl>
      {pkg.source === "user" && <RemoveView id={id} name={view.label} onRemoved={() => go("views")} />}
    </section>}
  </div>;
}

function RemoveView({ id, name, onRemoved }: { id: string; name: string; onRemoved: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!confirm) return <button className="settings-text-button danger" onClick={() => setConfirm(true)}><Trash2 size={13} />Remove {name}</button>;
  return <div className="settings-remove-confirm">
    <p>Remove {name}? Its saved layout is kept, and your work keeps running.</p>
    {error && <p role="alert" className="settings-note error">{error}</p>}
    <div className="settings-actions">
      <button className="settings-button" onClick={() => setConfirm(false)}>Keep it</button>
      <button className="settings-button danger" onClick={() => void window.hive.removeViewPackage(id).then(() => { rescan(); onRemoved(); }, (e: Error) => setError(e.message))}>Remove</button>
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
      <button className="settings-button" onClick={() => {
        const current = { ...getSettings().views.toolbars };
        delete current[mode];
        patchSettings("views.toolbars", current);
      }}>Reset actions</button>
    </div>
    <ol className="settings-toolbar-actions" aria-label="Toolbar actions">
      {rows.map((action) => {
        const index = selected.indexOf(action.id);
        return <li key={action.id} data-toolbar-setting={action.id}>
          <label><input type="checkbox" checked={index >= 0} onChange={(event) => update({ actions: event.target.checked ? [...selected, action.id] : selected.filter((id) => id !== action.id) })} />{action.label}</label>
          <button className="settings-icon-button" aria-label={`Move ${action.label} up`} disabled={index <= 0} onClick={() => move(action.id, -1)}><ArrowUp size={14} /></button>
          <button className="settings-icon-button" aria-label={`Move ${action.label} down`} disabled={index < 0 || index === selected.length - 1} onClick={() => move(action.id, 1)}><ArrowDown size={14} /></button>
        </li>;
      })}
    </ol>
    {selected.length === 0 && <p className="settings-note">No toolbar actions selected. Settings and custom view controls remain available.</p>}
  </details>;
}
