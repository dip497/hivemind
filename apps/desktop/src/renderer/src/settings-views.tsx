import { useEffect, useState } from "react";
import { isPluginOn } from "@hivemind/core/plugin-settings";
import { ArrowDown, ArrowUp, ChevronDown, ExternalLink, Puzzle, Trash } from "./components/icons";
import { Button } from "./components/ui/button";
import { PluginGroup, PluginRow } from "./plugins/PluginList";
import { useHubDescription } from "./plugins/library";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import { getSettings, patchSettings, useSettings, switchPlugin } from "./settings-store";
import { getView, resolveChrome, resolveViewId, useViews } from "./workspace/workspace-view";
import { setViewMode, useViewMode } from "./workspace/view-mode-store";
import type { IslandPlacement } from "@hivemind/core/settings-schema";
import { BUILTIN_TOOLBAR_ACTIONS, resolveToolbar, type ToolbarActionId, type ToolbarPreferences } from "@hivemind/core/toolbar";
import { useCommunityReport } from "./workspace/views/community/registry";
import { useSettingsNavigate } from "./settings-panels";

export const rescan = () => { window.dispatchEvent(new CustomEvent("hivemind:reload-views")); };

/** The views on the Plugins page: the one in use says so; one off or that cannot load is listed
 *  from its package, so it can be opened and switched back on. */
export function ViewsSection({ matches }: { matches: (text: string) => boolean }) {
  const mode = resolveViewId(useViewMode()) ?? "canvas";
  const report = useCommunityReport();
  const hub = useHubDescription();
  useEffect(rescan, []);
  const on = useViews().filter((v) => matches(`${v.label} ${v.id} ${v.hint}`));
  const off = report.packages.filter((p) => report.refused[p.id] && matches(`${p.manifest?.name ?? p.id} ${p.id}`));
  const count = on.length + off.length;
  // A package says what it does only through HiveHub; a built-in view says it in its hint.
  const about = (id: string): string | undefined => report.packages.some((x) => x.id === id) ? hub("view", id) : undefined;
  if (!count) return null;
  return <PluginGroup kind="view" count={count} foot={<p>⌘E switches between the views that are on.</p>}>
    {on.map((v) => <PluginRow key={v.id} kind="view" id={v.id} name={v.label} line={about(v.id) ?? v.hint} mark={<v.icon />} badge={mode === v.id ? "In use" : undefined} />)}
    {off.map((p) => {
      const why = report.refused[p.id]!;
      const switchedOff = why === "disabled in Settings";
      return <PluginRow key={p.id} kind="view" id={p.id} name={p.manifest?.name ?? p.id} mark={<Puzzle />}
        line={switchedOff ? about(p.id) ?? "" : why}
        state={switchedOff ? "off" : "unavailable"} badge={switchedOff ? "Off" : "Can't load"} />;
    })}
  </PluginGroup>;
}

/** A view's own mark; one that cannot load yet is a puzzle piece. */
export function ViewMark({ id, size = 22 }: { id: string; size?: number }) {
  const Icon = useViews().find((v) => v.id === id)?.icon ?? Puzzle;
  return <Icon size={size} />;
}

/** At the top of a view's page: using it, and switching one you added on or off. */
export function ViewActions({ id }: { id: string }) {
  const view = useViews().find((v) => v.id === id);
  const mode = resolveViewId(useViewMode()) ?? "canvas";
  const pkg = useCommunityReport().packages.find((p) => p.id === id);
  const on = isPluginOn(useSettings().plugins.state, "view", pkg ?? { id });
  const name = view?.label ?? pkg?.manifest?.name ?? id;
  return <>
    {view && (mode === id ? <span className="agent-badge">In use</span> : <Button variant="outline" onClick={() => setViewMode(id)}>Use this view</Button>)}
    {pkg && <Switch aria-label={`Enable ${name}`} checked={on} disabled={!view && !!pkg.error}
      onCheckedChange={() => void switchPlugin("view", pkg, !on).then(rescan)} />}
  </>;
}

export function ViewPage({ id }: { id: string }) {
  const view = getView(id);
  const settings = useSettings();
  const report = useCommunityReport();
  const go = useSettingsNavigate();
  useEffect(rescan, []);
  // Every hook runs first: switching this view off unregisters it while the page is still mounted.
  const pkg = report.packages.find((p) => p.id === id);
  if (!view && pkg) {
    const on = isPluginOn(settings.plugins.state, "view", pkg);
    const name = pkg.manifest?.name ?? id;
    return <div className="plugin-page" data-view-page={id}>
      <p className={on ? "settings-note error" : "settings-note"}>{on ? report.refused[id] ?? pkg.error : "Switch it on to choose it as your workspace view."}</p>
      {pkg.source === "user" && <RemoveView id={id} name={name} onRemoved={() => go("plugins")} />}
    </div>;
  }
  if (!view) return <p className="settings-empty">There is no view named {id}.</p>;
  const override = settings.views.chrome[id]?.island;
  return <div className="plugin-page" data-view-page={id}>
    <section className="plugin-section" aria-label="Toolbar">
      <h3>Toolbar</h3>
      <div className="settings-row">
        <div><label htmlFor="toolbar-position">Display</label><p>Use the view’s default or choose a position.</p></div>
        <Select value={override ?? "auto"} onValueChange={(v) => {
          const chrome = { ...getSettings().views.chrome };
          if (v === "auto") delete chrome[id];
          else chrome[id] = { island: v as IslandPlacement };
          patchSettings("views.chrome", chrome);
        }}>
          <SelectTrigger id="toolbar-position" className="min-w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Automatic ({resolveChrome(view).island})</SelectItem>
            <SelectItem value="top">Top</SelectItem><SelectItem value="bottom">Bottom</SelectItem><SelectItem value="hidden">Collapsed</SelectItem><SelectItem value="off">Off</SelectItem>
          </SelectContent>
        </Select>
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
  if (!confirm) return <Button variant="ghost-destructive" className="mt-3 -ml-3" onClick={() => setConfirm(true)}><Trash />Remove {name}</Button>;
  return <div className="settings-remove-confirm">
    <p>Remove {name}? Its saved layout is kept, and your work keeps running.</p>
    {error && <p role="alert" className="settings-note error">{error}</p>}
    <div className="settings-actions">
      <Button variant="outline" onClick={() => setConfirm(false)}>Keep it</Button>
      <Button variant="destructive" onClick={() => void window.hive.removeViewPackage(id).then(() => { rescan(); onRemoved(); }, (e: Error) => setError(e.message))}>Remove</Button>
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
      <Button variant="outline" onClick={() => {
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
          <Button variant="ghost" size="icon" aria-label={`Move ${action.label} up`} disabled={index <= 0} onClick={() => move(action.id, -1)}><ArrowUp /></Button>
          <Button variant="ghost" size="icon" aria-label={`Move ${action.label} down`} disabled={index < 0 || index === selected.length - 1} onClick={() => move(action.id, 1)}><ArrowDown /></Button>
        </li>;
      })}
    </ol>
    {selected.length === 0 && <p className="settings-note">No toolbar actions selected. Settings and custom view controls remain available.</p>}
  </details>;
}
