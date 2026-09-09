import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, FolderPlus, Puzzle, RefreshCw, Globe2, LayoutGrid, PanelsTopLeft, Trash2 } from "lucide-react";
import { getSettings, patchSettings, useSettings } from "./settings-store";
import { getView, resolveChrome, resolveViewId, useViews } from "./workspace/workspace-view";
import { setViewMode, useViewMode } from "./workspace/view-mode-store";
import { toast } from "sonner";
import { BUNDLED_TOOL_PLUGINS } from "@hivemind/core/tool-plugins";
import type { IslandPlacement } from "@hivemind/core/settings-schema";
import { BUILTIN_TOOLBAR_ACTIONS, resolveToolbar, type ToolbarActionId, type ToolbarPreferences } from "@hivemind/core/toolbar";
import { useCommunityReport } from "./workspace/views/community/registry";

const rescan = () => { window.dispatchEvent(new CustomEvent("hivemind:reload-views")); };
const copy: Record<string, string> = {
  canvas: "Infinite canvas",
  windows: "Tabbed workspace",
  world: "3D workspace",
};

export function ViewSettings({ onExtensions }: { onExtensions: () => void }) {
  const views = useViews();
  const mode = resolveViewId(useViewMode()) ?? "canvas";
  const settings = useSettings();
  const current = getView(mode);
  const override = settings.views.chrome[mode]?.island;
  useEffect(rescan, []);
  return <div className="settings-stack">
    <section aria-label="Workspace views">
      <div className="settings-section-heading"><h3>Workspace view</h3></div>
      <div className="settings-view-list">
        {views.map((view) => <button key={view.id} className="settings-view-choice" aria-pressed={mode === view.id} onClick={() => setViewMode(view.id)}>
          <span className="settings-view-icon" aria-hidden="true">
            {view.id === "canvas" ? <LayoutGrid size={19} /> : view.id === "windows" ? <PanelsTopLeft size={19} /> : view.id === "world" ? <Globe2 size={19} /> : <Puzzle size={19} />}
          </span>
          <span className="settings-view-copy"><span className="settings-view-name">{view.label}</span><span className="settings-view-description">{copy[view.id] ?? "Extension"}</span></span>
          <span className="settings-selection" aria-hidden="true">{mode === view.id && <Check size={15} />}</span>
        </button>)}
      </div>
      <button className="settings-text-button" onClick={onExtensions}><Puzzle size={14} />Manage view extensions</button>
    </section>
    <section className="settings-section" aria-label="Workspace toolbar">
      <div className="settings-section-heading"><h3>Workspace toolbar</h3><span>Applies to {current?.label ?? "this view"}</span></div>
      <div className="settings-row">
        <div><label htmlFor="toolbar-position">Display</label><p>Use the view’s default or choose a position.</p></div>
        <select id="toolbar-position" value={override ?? "auto"} onChange={(e) => {
          const chrome = { ...getSettings().views.chrome };
          if (e.target.value === "auto") delete chrome[mode];
          else chrome[mode] = { island: e.target.value as IslandPlacement };
          patchSettings("views.chrome", chrome);
        }}>
          <option value="auto">Automatic ({resolveChrome(current).island})</option>
          <option value="top">Top</option><option value="bottom">Bottom</option><option value="hidden">Collapsed</option><option value="off">Off</option>
        </select>
      </div>
      {override === "hidden" && <p className="settings-note">Show a handle to expand the toolbar.</p>}
      {override === "off" && <p className="settings-note">Shortcuts and custom view controls remain available.</p>}
      <ToolbarSettings mode={mode} />
    </section>
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
    <p className="settings-note">Choose the buttons and their order. Enable tools in Extensions.</p>
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

type Preview = NonNullable<Awaited<ReturnType<typeof window.hive.previewViewInstall>>>;

export function ExtensionSettings() {
  const report = useCommunityReport();
  const settings = useSettings();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(rescan, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "The extension could not be updated."); }
    finally { setBusy(false); }
  };
  return <div className="settings-stack">
    <section aria-label="Tool plugins">
      <div className="settings-section-heading"><h3>Tools</h3><span>Included with the app</span></div>
      <p className="settings-note">Enable the tools you need. Disabling a tool keeps existing panels open.</p>
      <div className="settings-extension-list">
        {BUNDLED_TOOL_PLUGINS.map((plugin) => {
          const title = plugin.tools.map((tool) => tool.label).join(", ");
          const ids = plugin.tools.map((tool) => `${plugin.id}/${tool.key}`);
          const enabled = settings.tools.enabledPlugins.includes(plugin.id) && ids.some((id) => !settings.tools.disabledTools.includes(id));
          return <div className="settings-extension" key={plugin.id} data-tool-plugin={plugin.id}>
            <div className="settings-extension-row">
              <div className="settings-extension-icon"><Puzzle size={19} /></div>
              <div className="settings-extension-label"><h4>{title}</h4><p>{enabled ? "Enabled" : "Disabled"}</p></div>
              <button className="settings-switch" role="switch" aria-label={`Enable ${title}`} aria-checked={enabled} onClick={() => {
                const current = getSettings().tools;
                if (!enabled) toast.dismiss("browser-disabled");
                patchSettings("tools.enabledPlugins", enabled ? current.enabledPlugins.filter((id) => id !== plugin.id) : [...new Set([...current.enabledPlugins, plugin.id])]);
                if (!enabled) patchSettings("tools.disabledTools", current.disabledTools.filter((id) => !ids.includes(id)));
              }}><span /></button>
            </div>
          </div>;
        })}
      </div>
    </section>
    <div className="settings-section-heading settings-extension-intro">
      <div><h3>Community views</h3></div>
      <button className="settings-button" disabled={busy} onClick={() => void act(async () => setPreview(await window.hive.previewViewInstall()))}><FolderPlus size={15} />Install from folder</button>
    </div>
    {error && <div role="alert" className="settings-message error">{error}</div>}
    {notice && <div role="status" className="settings-message">{notice}</div>}
    {preview && <section className="settings-install-review" aria-label="Review extension">
      <div className="settings-section-heading"><h3>Review installation</h3><span>{preview.package.manifest?.name} · {preview.package.manifest?.version}</span></div>
      <p>This view can display workspace names and agent status, and open your existing tools.</p>
      <p>{preview.package.manifest?.permissions.length ? `Additional access: ${preview.package.manifest.permissions.join(", ")}` : "No additional access requested."}</p>
      {preview.replacesVersion && <p className="settings-note">Replaces installed version {preview.replacesVersion}. Your saved layout is kept.</p>}
      <div className="settings-actions"><button className="settings-button" disabled={busy} onClick={() => setPreview(null)}>Cancel</button><button className="settings-button primary" disabled={busy} onClick={() => void act(async () => {
        await window.hive.installViewPackage(preview.token);
        setNotice(`${preview.package.manifest?.name} installed. Select it in Views when you’re ready.`); setPreview(null); rescan();
      })}>{busy ? "Installing…" : preview.replacesVersion ? "Replace extension" : "Install extension"}</button></div>
    </section>}
    <section>
      <div className="settings-section-heading"><h3>Installed</h3><button className="settings-icon-button" aria-label="Refresh extensions" onClick={rescan}><RefreshCw size={14} /></button></div>
      {!report.packages.length && <p className="settings-empty">No community views installed.</p>}
      <div className="settings-extension-list">
        {report.packages.map((pkg) => {
          const enabled = !settings.plugins.disabled.includes(pkg.id);
          const refused = report.refused[pkg.id];
          const problem = refused && refused !== "disabled in Settings" ? refused : null;
          return <div className="settings-extension" key={`${pkg.source}:${pkg.dir}`} data-community-pkg={pkg.id}>
            <div className="settings-extension-row">
              <div className="settings-extension-icon"><Puzzle size={19} /></div>
              <div className="settings-extension-label"><h4>{pkg.manifest?.name ?? pkg.id}</h4><p>{pkg.manifest?.version ?? "Invalid package"}<span>·</span>{problem ? "Unavailable" : enabled ? "Enabled" : "Disabled"}</p></div>
              <button className="settings-switch" role="switch" aria-label={`Enable ${pkg.id}`} aria-checked={enabled} disabled={busy || !!pkg.error} onClick={() => {
                const disabled = getSettings().plugins.disabled;
                patchSettings("plugins.disabled", enabled ? [...new Set([...disabled, pkg.id])] : disabled.filter((id) => id !== pkg.id)); rescan();
              }}><span /></button>
            </div>
            {problem && <p role="status" className="settings-note error">{problem}</p>}
            <details><summary>Details <ChevronDown size={12} /></summary>
              <dl><dt>Available to</dt><dd>{pkg.source === "user" ? "All your workspaces" : "This repository"}</dd><dt>Location</dt><dd className="settings-path">{pkg.dir}</dd><dt>Additional access</dt><dd>{pkg.manifest?.permissions.join(", ") || "None"}</dd></dl>
              {pkg.source === "user" ? removing === pkg.id ? <div className="settings-remove-confirm"><p>Remove {pkg.manifest?.name ?? pkg.id}? Its saved layout will be kept.</p><div className="settings-actions"><button className="settings-button" disabled={busy} onClick={() => setRemoving(null)}>Keep extension</button><button className="settings-button danger" disabled={busy} onClick={() => void act(async () => { await window.hive.removeViewPackage(pkg.id); setRemoving(null); rescan(); setNotice("Extension removed. Your work is still running."); })}>Remove extension</button></div></div> : <button className="settings-text-button danger" disabled={busy} onClick={() => setRemoving(pkg.id)}><Trash2 size={13} />Remove extension</button> : <p className="settings-note">Included by this repository. Disable it here to stop using it.</p>}
            </details>
          </div>;
        })}
      </div>
    </section>
    <details className="settings-developer-details"><summary>Install with the CLI <ChevronDown size={12} /></summary><p>The desktop and CLI use the same extension library.</p><code>hive views install &lt;folder&gt;</code><p>Use a built package containing hivemind-view.json and its bundled assets.</p></details>
  </div>;
}
