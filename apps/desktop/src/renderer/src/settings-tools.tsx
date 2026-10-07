import { useEffect, useState } from "react";
import { ChevronRight, FileCodeCorner, Earth, ListTodo } from "lucide-react";
import { toast } from "sonner";
import { BUNDLED_TOOL_PLUGINS, BROWSER_PLUGIN_ID, bundledToolRegistry, CODE_PLUGIN_ID, ISSUES_PLUGIN_ID } from "@hivemind/core/tool-plugins";
import { toolPreferences } from "@hivemind/core/settings-schema";
import { patchPluginState, useSettings } from "./settings-store";
import { Button } from "./components/ui/button";
import { Switch } from "./components/ui/switch";
import { useSettingsNavigate } from "./settings-panels";
import { toolLabel } from "./settings-nav";

function useToolEnabled(pluginId: string): [boolean, () => void] {
  const settings = useSettings();
  const plugin = BUNDLED_TOOL_PLUGINS.find((p) => p.id === pluginId);
  const ids = plugin?.tools.map((tool) => `${pluginId}/${tool.key}`) ?? [];
  // The registry decides: a built-in is on without being in enabledPlugins, so
  // asking it is the only way this switch agrees with what the canvas offers.
  const resolved = bundledToolRegistry.resolve(toolPreferences(settings));
  const enabled = ids.some((id) => resolved.availability(id).available);
  const toggle = () => {
    if (!enabled) toast.dismiss(`${pluginId}-disabled`);
    // A tool switched off inside its plugin is that plugin's option, false; switching the plugin
    // on clears them, and a plugin that is not built in is on only when switched on.
    patchPluginState("tool", pluginId, (s) => {
      const options = Object.fromEntries(Object.entries(s.options ?? {}).filter(([k]) => !plugin?.tools.some((t) => t.key === k)));
      if (enabled && plugin?.builtin) return { ...s, options: { ...options, ...Object.fromEntries(plugin.tools.map((t) => [t.key, false])) } };
      return { ...s, options, ...(plugin?.builtin ? {} : { enabled: !enabled }) };
    });
  };
  return [enabled, toggle];
}

const ToolIcon = ({ pluginId, size }: { pluginId: string; size: number }) => {
  const Icon = pluginId === CODE_PLUGIN_ID ? FileCodeCorner : pluginId === ISSUES_PLUGIN_ID ? ListTodo : Earth;
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
      <Button variant="ghost" size="icon-sm" aria-label={`${title} settings`} data-plugin-open={`tool:${pluginId}`} onClick={() => go(`plugin:tool:${pluginId}`)}><ChevronRight /></Button>
      <Switch aria-label={`Enable ${title}`} checked={enabled} onCheckedChange={toggle} />
    </div>
  </div>;
}

/** The tools on the Plugins page: the optional ones, then the ones included. */
export function ToolsSection({ matches }: { matches: (text: string) => boolean }) {
  const shown = BUNDLED_TOOL_PLUGINS.filter((p) => matches(`${toolLabel(p.id)} ${p.id} ${p.tools.map((t) => t.description ?? "").join(" ")}`));
  const optional = shown.filter((p) => !p.builtin);
  const builtin = shown.filter((p) => p.builtin);
  if (!shown.length) return null;
  return <section className="settings-stack plugins-kind" aria-label="Tools" data-plugins-kind="tool">
    <h3 className="plugins-kind-heading">Tools</h3>
    {optional.length > 0 && <section aria-label="Optional tools">
      <div className="settings-section-heading"><h3>Optional tools</h3></div>
      <p className="settings-note">Switch on the ones you use; switching one off keeps open panels.</p>
      <div className="settings-extension-list">{optional.map((p) => <ToolRow key={p.id} pluginId={p.id} />)}</div>
    </section>}
    {builtin.length > 0 && <section aria-label="Included tools">
      <div className="settings-section-heading"><h3>Included</h3></div>
      <p className="settings-note">These come with Hivemind and are on unless you switch them off. Terminals and agent tiles are always available.</p>
      <div className="settings-extension-list">{builtin.map((p) => <ToolRow key={p.id} pluginId={p.id} />)}</div>
    </section>}
  </section>;
}

export function ToolPage({ id }: { id: string }) {
  const [enabled, toggle] = useToolEnabled(id);
  if (!BUNDLED_TOOL_PLUGINS.some((p) => p.id === id)) return <p className="settings-empty">There is no tool named {id}.</p>;
  const title = toolLabel(id);
  return <div className="plugin-page" data-tool-page={id}>
    <header className="plugin-head">
      <span className="plugin-mark"><ToolIcon pluginId={id} size={22} /></span>
      <div className="plugin-title"><p>{BUNDLED_TOOL_PLUGINS.find((p) => p.id === id)?.builtin ? "Included" : "Optional"} · {enabled ? "On" : "Off"}</p></div>
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
