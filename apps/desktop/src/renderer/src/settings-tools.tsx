import { useEffect, useState } from "react";
import { ChevronRight, Globe2 } from "lucide-react";
import { toast } from "sonner";
import { BUNDLED_TOOL_PLUGINS, BROWSER_PLUGIN_ID } from "@hivemind/core/tool-plugins";
import { getSettings, patchSettings, useSettings } from "./settings-store";
import { Button } from "./components/ui/button";
import { Switch } from "./components/ui/switch";
import { useSettingsNavigate } from "./settings-panels";
import { toolLabel } from "./settings-nav";

function useToolEnabled(pluginId: string): [boolean, () => void] {
  const settings = useSettings();
  const plugin = BUNDLED_TOOL_PLUGINS.find((p) => p.id === pluginId);
  const ids = plugin?.tools.map((tool) => `${pluginId}/${tool.key}`) ?? [];
  const enabled = settings.tools.enabledPlugins.includes(pluginId) && ids.some((id) => !settings.tools.disabledTools.includes(id));
  const toggle = () => {
    const current = getSettings().tools;
    if (!enabled) toast.dismiss("browser-disabled");
    patchSettings("tools.enabledPlugins", enabled ? current.enabledPlugins.filter((id) => id !== pluginId) : [...new Set([...current.enabledPlugins, pluginId])]);
    if (!enabled) patchSettings("tools.disabledTools", current.disabledTools.filter((id) => !ids.includes(id)));
  };
  return [enabled, toggle];
}

function ToolRow({ pluginId }: { pluginId: string }) {
  const [enabled, toggle] = useToolEnabled(pluginId);
  const go = useSettingsNavigate();
  const title = toolLabel(pluginId);
  const about = BUNDLED_TOOL_PLUGINS.find((p) => p.id === pluginId)?.tools[0]?.description;
  return <div className="settings-extension" data-tool-plugin={pluginId}>
    <div className="settings-extension-row">
      <div className="settings-extension-icon"><Globe2 size={19} /></div>
      <div className="settings-extension-label"><h4>{title}</h4>{about && <p>{about}</p>}</div>
      <Button variant="ghost" size="icon-sm" aria-label={`${title} settings`} onClick={() => go(`tool:${pluginId}`)}><ChevronRight /></Button>
      <Switch aria-label={`Enable ${title}`} checked={enabled} onCheckedChange={toggle} />
    </div>
  </div>;
}

export function ToolsOverview() {
  return <div className="settings-stack">
    <section aria-label="Tools">
      <div className="settings-section-heading"><h3>Optional tools</h3></div>
      <p className="settings-note">Terminals, the editor and issues are always available. Switch on the others you use; switching one off keeps open panels.</p>
      <div className="settings-extension-list">{BUNDLED_TOOL_PLUGINS.map((p) => <ToolRow key={p.id} pluginId={p.id} />)}</div>
    </section>
  </div>;
}

export function ToolPage({ id }: { id: string }) {
  const [enabled, toggle] = useToolEnabled(id);
  if (!BUNDLED_TOOL_PLUGINS.some((p) => p.id === id)) return <p className="settings-empty">There is no tool named {id}.</p>;
  const title = toolLabel(id);
  return <div className="plugin-page" data-tool-page={id}>
    <header className="plugin-head">
      <span className="plugin-mark"><Globe2 size={22} /></span>
      <div className="plugin-title"><p>Built in · {enabled ? "On" : "Off"}</p></div>
      <Switch aria-label={`Enable ${title}`} checked={enabled} onCheckedChange={toggle} />
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
      <div className="flex-1"><label>Agent browser control</label><p>Let agents interact with Browser panels.</p></div>
      <Switch aria-label="Enable agent browser control" checked={state.enabled} disabled={busy || (!toolOn && !state.enabled)} onCheckedChange={() => void toggle()} />
    </div>
    {!toolOn && !state.enabled && <p className="settings-note">Switch Browser on to use this.</p>}
    <p className="settings-note warn">Opens 127.0.0.1:{state.port}. Local processes can also control the app window. Only enable this for agents you trust.</p>
    <div className="settings-row">
      <span className="settings-note">Right now: {state.active ? "active" : "off"}</span>
      {state.enabled !== state.active && <Button size="sm" variant="outline" onClick={() => void window.hive.relaunchApp()}>Relaunch to apply</Button>}
    </div>
  </section>;
}
