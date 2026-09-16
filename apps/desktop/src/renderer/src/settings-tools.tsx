import { useEffect, useState } from "react";
import { ChevronRight, FileCode2, Globe2, ListTodo } from "lucide-react";
import { toast } from "sonner";
import { BUNDLED_TOOL_PLUGINS, BROWSER_PLUGIN_ID, bundledToolRegistry, CODE_PLUGIN_ID, ISSUES_PLUGIN_ID } from "@hivemind/core/tool-plugins";
import { getSettings, patchSettings, useSettings } from "./settings-store";
import { useSettingsNavigate } from "./settings-panels";
import { toolLabel } from "./settings-nav";

function useToolEnabled(pluginId: string): [boolean, () => void] {
  const settings = useSettings();
  const plugin = BUNDLED_TOOL_PLUGINS.find((p) => p.id === pluginId);
  const ids = plugin?.tools.map((tool) => `${pluginId}/${tool.key}`) ?? [];
  // The registry decides: a built-in is on without being in enabledPlugins, so
  // asking it is the only way this switch agrees with what the canvas offers.
  const resolved = bundledToolRegistry.resolve(settings.tools);
  const enabled = ids.some((id) => resolved.availability(id).available);
  const toggle = () => {
    const current = getSettings().tools;
    if (!enabled) toast.dismiss(`${pluginId}-disabled`);
    if (plugin?.builtin) {
      // Nothing to enable — switching it off means disabling its own tools.
      patchSettings("tools.disabledTools", enabled
        ? [...new Set([...current.disabledTools, ...ids])]
        : current.disabledTools.filter((id) => !ids.includes(id)));
      return;
    }
    patchSettings("tools.enabledPlugins", enabled ? current.enabledPlugins.filter((id) => id !== pluginId) : [...new Set([...current.enabledPlugins, pluginId])]);
    if (!enabled) patchSettings("tools.disabledTools", current.disabledTools.filter((id) => !ids.includes(id)));
  };
  return [enabled, toggle];
}

const ToolIcon = ({ pluginId, size }: { pluginId: string; size: number }) => {
  const Icon = pluginId === CODE_PLUGIN_ID ? FileCode2 : pluginId === ISSUES_PLUGIN_ID ? ListTodo : Globe2;
  return <Icon size={size} />;
};

function ToolRow({ pluginId }: { pluginId: string }) {
  const [enabled, toggle] = useToolEnabled(pluginId);
  const go = useSettingsNavigate();
  const title = toolLabel(pluginId);
  const about = BUNDLED_TOOL_PLUGINS.find((p) => p.id === pluginId)?.tools[0]?.description;
  return <div className="settings-extension" data-tool-plugin={pluginId}>
    <div className="settings-extension-row">
      <div className="settings-extension-icon"><ToolIcon pluginId={pluginId} size={19} /></div>
      <div className="settings-extension-label"><h4>{title}</h4>{about && <p>{about}</p>}</div>
      <button className="settings-icon-button" aria-label={`${title} settings`} onClick={() => go(`tool:${pluginId}`)}><ChevronRight size={15} /></button>
      <button className="settings-switch" role="switch" aria-label={`Enable ${title}`} aria-checked={enabled} onClick={toggle}><span /></button>
    </div>
  </div>;
}

export function ToolsOverview() {
  const optional = BUNDLED_TOOL_PLUGINS.filter((p) => !p.builtin);
  const builtin = BUNDLED_TOOL_PLUGINS.filter((p) => p.builtin);
  return <div className="settings-stack">
    <section aria-label="Tools">
      <div className="settings-section-heading"><h3>Optional tools</h3></div>
      <p className="settings-note">Switch on the ones you use; switching one off keeps open panels.</p>
      <div className="settings-extension-list">{optional.map((p) => <ToolRow key={p.id} pluginId={p.id} />)}</div>
    </section>
    <section aria-label="Included tools">
      <div className="settings-section-heading"><h3>Included</h3></div>
      <p className="settings-note">These come with Hivemind and are on unless you switch them off. Terminals and agent tiles are always available.</p>
      <div className="settings-extension-list">{builtin.map((p) => <ToolRow key={p.id} pluginId={p.id} />)}</div>
    </section>
  </div>;
}

export function ToolPage({ id }: { id: string }) {
  const [enabled, toggle] = useToolEnabled(id);
  if (!BUNDLED_TOOL_PLUGINS.some((p) => p.id === id)) return <p className="settings-empty">There is no tool named {id}.</p>;
  const title = toolLabel(id);
  return <div className="plugin-page" data-tool-page={id}>
    <header className="plugin-head">
      <span className="plugin-mark"><ToolIcon pluginId={id} size={22} /></span>
      <div className="plugin-title"><p>{BUNDLED_TOOL_PLUGINS.find((p) => p.id === id)?.builtin ? "Included" : "Optional"} · {enabled ? "On" : "Off"}</p></div>
      <button className="settings-switch" role="switch" aria-label={`Enable ${title}`} aria-checked={enabled} onClick={toggle}><span /></button>
    </header>
    {id === BROWSER_PLUGIN_ID && <BrowserControl toolOn={enabled} />}
  </div>;
}

/** The CDP bridge only applies at launch, so the choice is saved and a relaunch offered. */
function BrowserControl({ toolOn }: { toolOn: boolean }) {
  const [state, setState] = useState<{ active: boolean; enabled: boolean; port: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void window.hive.getBrowserSettings().then(setState).catch(() => {}); }, []);
  if (!state) return null;
  const toggle = async () => {
    setBusy(true);
    try { await window.hive.setBrowserCdpEnabled(!state.enabled); setState({ ...state, enabled: !state.enabled }); }
    finally { setBusy(false); }
  };
  return <section className="plugin-section" aria-label="Browser control">
    <h3>Agent control</h3>
    <div className="settings-row">
      <div><label>Agent browser control</label><p>Let agents interact with Browser panels.</p></div>
      <button className="settings-switch" role="switch" aria-label="Enable agent browser control" aria-checked={state.enabled} disabled={busy || (!toolOn && !state.enabled)} onClick={() => void toggle()}><span /></button>
    </div>
    {!toolOn && !state.enabled && <p className="settings-note">Switch Browser on to use this.</p>}
    <p className="settings-note warn">Opens 127.0.0.1:{state.port}. Local processes can also control the app window. Only enable this for agents you trust.</p>
    <div className="settings-row">
      <span className="settings-note">Right now: {state.active ? "active" : "off"}</span>
      {state.enabled !== state.active && <button onClick={() => void window.hive.relaunchApp()} className="settings-button">Relaunch to apply</button>}
    </div>
  </section>;
}
