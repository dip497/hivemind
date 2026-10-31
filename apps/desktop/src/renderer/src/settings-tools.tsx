import { Input } from "./components/ui/input";
import { useEffect, useState } from "react";
import { FileCode, Earth, ListTodo, Puzzle, Trash } from "./components/icons";
import { toast } from "sonner";
import { BUNDLED_TOOL_PLUGINS, BROWSER_PLUGIN_ID, bundledToolRegistry, CODE_PLUGIN_ID, ISSUES_PLUGIN_ID } from "@hivemind/core/tool-plugins";
import { toolPreferences } from "@hivemind/core/settings-schema";
import { isPluginOn, pluginOptions, resolveSettings } from "@hivemind/core/plugin-settings";
import { patchPluginState, patchSettings, setPluginOption, switchPlugin, useSettings } from "./settings-store";
import { Button } from "./components/ui/button";
import { Switch } from "./components/ui/switch";
import { versionAfter } from "../../shared/release-notes";
import { useSettingsNavigate } from "./settings-navigate";
import { toolLabel } from "./settings-nav";
import { useToolPackages, useToolProblem } from "./tiles/tool-plugins";
import { SettingsForm } from "./plugins/SettingsForm";
import { ServiceSection } from "./plugins/ServiceSection";
import { cleanError } from "./plugins/catalog-install";
import { PluginRow, type ListedRow } from "./plugins/PluginList";
import { heldOffByPackage, partOfPackage } from "./plugins/package-rows";
import type { PluginCategory } from "@hivemind/view-sdk/category";
import { tileKind, useTilesVersion } from "./tiles/api";
import type { ToolPackage } from "@hivemind/core/tool-format";

/** A tool plugin you added, by id; undefined for one that comes with the app. */
function useAdded(pluginId: string): ToolPackage | undefined {
  return useToolPackages().packages.find((p) => p.id === pluginId && p.source === "you");
}

function useToolEnabled(pluginId: string): [boolean, () => void] {
  const settings = useSettings();
  const added = useAdded(pluginId);
  if (added) {
    const on = isPluginOn(settings.plugins.state, "tool", added, false);
    return [on, () => void switchPlugin("tool", added, !on).catch((e: unknown) => toast.error(cleanError(e)))];
  }
  return bundledEnabled(pluginId, settings);
}

function bundledEnabled(pluginId: string, settings: ReturnType<typeof useSettings>): [boolean, () => void] {
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

export const ToolIcon = ({ pluginId, size }: { pluginId: string; size: number }) => {
  const Icon = pluginId === CODE_PLUGIN_ID ? FileCode : pluginId === ISSUES_PLUGIN_ID ? ListTodo : pluginId === BROWSER_PLUGIN_ID ? Earth : Puzzle;
  return <Icon size={size} />;
};

function ToolRow({ pluginId }: { pluginId: string }) {
  const [enabled] = useToolEnabled(pluginId);
  const added = useAdded(pluginId);
  const problem = useToolProblem(pluginId);
  const part = added && partOfPackage(added);
  const about = part ? `Part of ${part.name}` : added?.description ?? BUNDLED_TOOL_PLUGINS.find((p) => p.id === pluginId)?.tools[0]?.description ?? "";
  return <PluginRow kind="tool" id={pluginId} name={toolLabel(pluginId)} mark={<ToolIcon pluginId={pluginId} size={16} />}
    line={problem ?? about} state={problem ? "unavailable" : enabled ? "on" : "off"} badge={problem ? "Can't load" : enabled ? undefined : "Off"} />;
}

function RemoveTool({ pkg }: { pkg: ToolPackage }) {
  const go = useSettingsNavigate();
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button variant="ghost-destructive" className="mt-3 -ml-3" onClick={() => setAsking(true)}><Trash />Remove {pkg.name}</Button>;
  return <div className="settings-remove-confirm">
    <p>Remove {pkg.name}? Its panels close.</p>
    <div className="settings-actions">
      <Button variant="outline" onClick={() => setAsking(false)}>Keep it</Button>
      <Button variant="destructive" onClick={() => void window.hive.removeToolPackage(pkg.id).then(() => go("plugins"), (e) => toast.error(cleanError(e)))}>Remove</Button>
    </div>
  </div>;
}

/** The tools on the Plugins page: the ones included, the optional ones, then the ones you added. */
/** The tools you have, as rows of the Plugins page: one that comes with the app under its tile's
 *  category, as the Add menu lists it, and one you added under its manifest's. The warning is why
 *  the list could not be read, or safe mode, where none you added runs. */
export function useToolRows(matches: (text: string) => boolean): { rows: ListedRow[]; warning: string | null } {
  const shown = BUNDLED_TOOL_PLUGINS.filter((p) => matches(`${toolLabel(p.id)} ${p.id} ${p.tools.map((t) => t.description ?? "").join(" ")}`));
  const { packages, safeMode, error } = useToolPackages();
  useTilesVersion();
  const added = packages.filter((p) => p.source === "you" && matches(`${p.name} ${p.id} ${p.description}`));
  const bundled = [...shown.filter((p) => p.builtin), ...shown.filter((p) => !p.builtin)];
  const row = (id: string, category: PluginCategory): ListedRow => ({ key: `tool:${id}`, kind: "tool", category, row: <ToolRow pluginId={id} /> });
  return {
    rows: [
      ...bundled.map((p) => row(p.id, p.tools.map((t) => t.tileKind ? tileKind(t.tileKind).category : undefined).find((c) => c !== undefined) ?? "other")),
      ...added.map((p) => row(p.id, p.category)),
    ],
    warning: error ?? (added.length > 0 && safeMode ? "Hivemind started in safe mode: no tool you added runs until you start it normally." : null),
  };
}

/** At the top of a tool's page: switching it on or off. */
export function ToolActions({ id }: { id: string }) {
  const [enabled, toggle] = useToolEnabled(id);
  const added = useAdded(id);
  return <Switch aria-label={`Enable ${toolLabel(id)}`} checked={enabled} disabled={!!added?.problem || (!!added && heldOffByPackage(added))} onCheckedChange={toggle} />;
}

export function ToolPage({ id }: { id: string }) {
  const [enabled] = useToolEnabled(id);
  const added = useAdded(id);
  const stored = useSettings().plugins.state;
  if (!added && !BUNDLED_TOOL_PLUGINS.some((p) => p.id === id)) return <p className="settings-empty">There is no tool named {id}.</p>;
  return <div className="plugin-page" data-tool-page={id}>
    {added && <p className="settings-note">It runs inside the app, with the access it has. Switch it on only if you trust who wrote it.</p>}
    {added && added.settings.length > 0 && <section className="plugin-section" aria-label="Its settings" data-plugin-settings={`tool:${id}`}>
      <h3>Its settings</h3>
      <SettingsForm fields={added.settings} values={resolveSettings(added.settings, pluginOptions(stored, "tool", id))} onChange={(f, v) => setPluginOption("tool", id, f, v)} />
    </section>}
    {added?.service && <ServiceSection id={id} service={added.service} on={enabled} />}
    {id === BROWSER_PLUGIN_ID && <BrowserControl toolOn={enabled} />}
    {added && !partOfPackage(added) && <RemoveTool pkg={added} />}
  </div>;
}

/** The CDP bridge only applies at launch, so the choice is saved and a relaunch offered. */
function BrowserControl({ toolOn }: { toolOn: boolean }) {
  const [state, setState] = useState<{ active: boolean; enabled: boolean; port: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void window.hive.getBrowserSettings?.().then(setState).catch(() => {}); }, []);
  if (!state) return null;
  const toggle = async () => {
    setBusy(true);
    try { await window.hive.setBrowserCdpEnabled?.(!state.enabled); setState({ ...state, enabled: !state.enabled }); }
    finally { setBusy(false); }
  };
  return <section className="plugin-section" aria-label="Browser control">
    <h3>Agent control</h3>
    <div className="settings-row">
      <div className="flex-1"><label>Agent browser control</label><p>Let agents interact with Browser panels.</p></div>
      <Switch aria-label="Enable agent browser control" checked={state.enabled} disabled={busy || (!toolOn && !state.enabled)} onCheckedChange={() => void toggle()} />
    </div>
    {!toolOn && !state.enabled && <p className="settings-note">Switch Browser on to use this.</p>}
    <p className="settings-note warn">Opens 127.0.0.1:{state.port}, which shows agents only the Browser tiles. Any program on this computer can use it, and one that looks for it can reach the app window too. Only enable this for agents you trust.</p>
    <div className="settings-row">
      <span className="settings-note">Right now: {state.active ? "active" : "off"}</span>
      {state.enabled !== state.active && <Button variant="outline" onClick={() => void window.hive.relaunchApp?.()}>Relaunch to apply</Button>}
    </div>
    {(state.enabled || state.active) && <AgentBrowser />}
  </section>;
}

/** agent-browser, the CLI agents drive Browser tiles with: which one is here, an install or update
 *  of it, and how terminals use it. */
function AgentBrowser() {
  const { agentBrowser } = useSettings();
  const [status, setStatus] = useState<{ installed: string | null; latest: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => { void window.hive.agentBrowserStatus?.().then(setStatus).catch(() => {}); }, []);
  const install = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await window.hive.agentBrowserInstall!();
      setStatus((s) => ({ installed: r.version, latest: s?.latest ?? null }));
      setSaid(r.ok ? `agent-browser ${r.version ?? ""} is installed.` : `It did not install: ${r.out}`);
    } finally { setBusy(false); }
  };
  const newer = status?.installed && status.latest && status.latest !== status.installed && versionAfter(status.latest, status.installed);
  return <div className="flex flex-col gap-2" data-agent-browser>
    <div className="settings-row">
      <div className="flex-1">
        <label>agent-browser</label>
        <p data-agent-browser-version>
          {!status ? "Looking…"
            : status.installed ? `${status.installed} is installed${newer ? `; ${status.latest} is out` : status.latest ? ", the newest" : ""}.`
            : "Not installed. Agents can still run it with npx, which fetches it each time."}
        </p>
      </div>
      {status && (!status.installed || newer) && (
        <Button variant="outline" disabled={busy} onClick={() => void install()} data-agent-browser-install>
          {busy ? (status.installed ? "Updating…" : "Installing…") : status.installed ? `Update to ${status.latest}` : "Install"}
        </Button>
      )}
    </div>
    {said && <p className="settings-note" role="status">{said}</p>}
    <div className="settings-row">
      <div className="flex-1"><label>Use these Browser tiles</label><p>agent-browser in each terminal drives these tiles in a session of its own, and a new tab opens a Browser tile beside the agent. Off: it starts its own Chrome. For terminals started from now on.</p></div>
      <Switch aria-label="agent-browser uses these Browser tiles" checked={agentBrowser.useTiles} onCheckedChange={(v) => patchSettings("agentBrowser.useTiles", v)} />
    </div>
    <div className="settings-row">
      <div className="flex-1"><label>Mark what pages say</label><p>What a page says is marked as the page's, so an agent tells it apart from what you asked.</p></div>
      <Switch aria-label="Mark what pages say" checked={agentBrowser.markPageText} onCheckedChange={(v) => patchSettings("agentBrowser.markPageText", v)} />
    </div>
    <SignIns />
  </div>;
}

/** Sign-ins an agent can use by name: the app types the password, and the person says yes on the tile. */
function SignIns() {
  const [saved, setSaved] = useState<{ name: string; site: string; username: string; always: boolean }[]>([]);
  const [keychain, setKeychain] = useState(true);
  const [draft, setDraft] = useState({ name: "", url: "", username: "", password: "" });
  const [said, setSaid] = useState<string | null>(null);
  const load = () => void window.hive.browserSignIns?.().then((r) => { setSaved(r.signIns); setKeychain(r.keychain); }).catch(() => {});
  useEffect(load, []);
  const save = async () => {
    setSaid(null);
    try {
      await window.hive.browserSignInSave!(draft);
      setDraft({ name: "", url: "", username: "", password: "" });
      load();
    } catch (e) { setSaid((e as Error).message.replace(/^\[[^\]]*\]\s*/, "")); }
  };
  const field = (key: keyof typeof draft, placeholder: string, type = "text") => (
    <Input aria-label={placeholder} placeholder={placeholder} type={type} autoComplete="off" value={draft[key]} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
  );
  return <div className="flex flex-col gap-2" data-sign-ins>
    <div className="settings-row">
      <div className="flex-1">
        <label>Sign-ins</label>
        <p>An agent asks for one by name and you say yes on the tile. The app types the password, on that site only, and the agent never sees it.{keychain ? "" : " This computer has no keychain, so they are protected only by your account's file permissions."}</p>
      </div>
    </div>
    {saved.map((s) => (
      <div className="settings-row" key={s.name} data-sign-in={s.name}>
        <div className="min-w-0 flex-1"><label>{s.name}</label><p className="truncate">{s.username} on {s.site}{s.always ? ", without asking" : ""}</p></div>
        <Button variant="outline" onClick={() => void window.hive.browserSignInRemove!(s.name).then(load)}>Remove</Button>
      </div>
    ))}
    <div className="grid grid-cols-2 gap-2">
      {field("name", "Name, e.g. github")}
      {field("url", "Sign-in address")}
      {field("username", "Username")}
      {field("password", "Password", "password")}
    </div>
    {said && <p className="settings-note" role="status">{said}</p>}
    <div><Button variant="outline" disabled={!draft.name || !draft.url || !draft.username || !draft.password} onClick={() => void save()}>Save sign-in</Button></div>
  </div>;
}
