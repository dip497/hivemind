/**
 * One plugin's page, the same for every kind, before and after it is installed: what it is, and
 * three tabs — its settings, its README, and what it may do and where it comes from. Settings are
 * drawn from what the plugin declares; an agent's, a view's and a tool's own controls (launch
 * options, the toolbar, browser control) sit in the same tab.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, LayoutGrid, Trash } from "../components/icons";
import { CatalogMark } from "../settings-plugins";
import { cleanError } from "./catalog-install";
import { isPluginOn, pluginOptions, resolveSettings } from "@hivemind/core/plugin-settings";
import { Button } from "../components/ui/button";
import { Loading } from "../components/ui/loading";
import { Switch } from "../components/ui/switch";
import { useSettingsNavigate } from "../settings-panels";
import { setPluginOption, switchPlugin, useSettings } from "../settings-store";
import { AgentActions, AgentMark, AgentPage } from "../settings-agents";
import { ViewActions, ViewMark, ViewPage } from "../settings-views";
import { ToolActions, ToolIcon, ToolPage } from "../settings-tools";
import { WidgetIcon } from "./WidgetIcon";
import { catalogImage } from "./mask-icon";
import { useWidgetPackages } from "../board-objects/widget-runtime";
import { useCommunityReport } from "../workspace/views/community/registry";
import { SettingsForm } from "./SettingsForm";
import { setPluginsScope, showPackage } from "./scope";
import { heldOffByPackage, partOfPackage } from "./package-rows";
import { useToolPackages } from "../tiles/tool-plugins";
import { KIND_LABEL, ORIGIN_LABEL, useCatalog, usePlugins, type PluginRecord } from "./library";

const MarkdownPreview = lazy(() => import("../markdown-preview").then((m) => ({ default: m.MarkdownPreview })));

function useReadme(p: PluginRecord | undefined): { text: string | null; loading: boolean } {
  const [state, setState] = useState<{ text: string | null; loading: boolean }>({ text: null, loading: true });
  const from = p?.readme;
  const key = JSON.stringify(from ?? null);
  useEffect(() => {
    if (!from) { setState({ text: null, loading: false }); return; }
    if ("text" in from) { setState({ text: from.text, loading: false }); return; }
    let live = true;
    setState({ text: null, loading: true });
    void window.hive.pluginReadme(from).then((text) => { if (live) setState({ text, loading: false }); }, () => { if (live) setState({ text: null, loading: false }); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

type Tab = "settings" | "readme" | "about";
const TAB_LABEL: Record<Tab, string> = { settings: "Settings", readme: "Read me", about: "What it can do" };

export function PluginPage({ kind, id }: { kind: string; id: string }) {
  const catalog = useCatalog();
  const plugins = usePlugins(catalog);
  const p = plugins.find((x) => x.kind === kind && x.id === id);
  const readme = useReadme(p);
  const go = useSettingsNavigate();
  const [chosen, setTab] = useState<Tab | null>(null);
  // One only HiveHub lists is known once its catalog is.
  if (!p && !catalog) return <Loading label="Loading HiveHub's catalog" />;
  if (!p) return <p className="settings-empty">This plugin is not here any more. <button type="button" className="settings-link" onClick={() => go("plugins")}>All plugins</button></p>;
  const tabs: Tab[] = p.installed ? ["settings", "readme", "about"] : ["readme", "about"];
  const tab = chosen && tabs.includes(chosen) ? chosen : tabs[0]!;
  const toHub = () => { setPluginsScope("hub"); go("plugins"); };
  return (
    <div className="settings-stack plugin-page" data-plugin-page={`${p.kind}:${p.id}`}>
      <Button variant="link" className="self-start" onClick={() => go("plugins")}><ArrowLeft />All plugins</Button>
      <header className="plugin-page-head">
        <span className="plugin-mark" aria-hidden="true"><PluginMark p={p} /></span>
        <div className="min-w-0 flex-1">
          <p className="plugin-page-meta">
            <span className="catalog-type">{KIND_LABEL[p.kind]}</span>
            {[p.author, p.version && `v${p.version}`, ORIGIN_LABEL[p.origin]].filter(Boolean).join(" · ")}
          </p>
          {p.description && <p className="plugin-page-description">{p.description}</p>}
        </div>
        <div className="plugin-page-actions">
          {p.catalog?.homepage && <Button variant="ghost" asChild><a href={p.catalog.homepage} target="_blank" rel="noreferrer">Source<ExternalLink /></a></Button>}
          {p.installed ? <PluginActions p={p} /> : <Button onClick={toHub}>Install from HiveHub</Button>}
        </div>
      </header>
      {p.problem && <p role="status" className="settings-note error">{p.problem}</p>}
      <PartOf p={p} />

      <div role="tablist" aria-label={`${p.name}`} className="plugin-tabs">
        {tabs.map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} data-plugin-tab={t} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>)}
      </div>

      <div role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {tab === "settings" && <PluginSettings p={p} />}
        {tab === "readme" && <section aria-label="Read me" className="plugin-readme">
          {readme.loading ? <Loading label="Loading its README" />
            : readme.text ? <Suspense fallback={null}><MarkdownPreview source={readme.text} className="md-preview" /></Suspense>
            : <p className="settings-empty">It has no README.</p>}
        </section>}
        {tab === "about" && <>
          <section aria-label="What it can do">
            {p.can.length
              ? <ul className="catalog-does">{p.can.map((c) => <li key={c}>{c}</li>)}</ul>
              : <p className="settings-note">Nothing beyond showing itself{p.kind === "agent" ? " and running its command in a terminal tile" : ""}.</p>}
          </section>
          <section aria-label="Details">
            <div className="settings-section-heading"><h3>Details</h3></div>
            <dl className="plugin-details">
              <dt>Id</dt><dd><code>{p.id}</code></dd>
              <dt>Where it comes from</dt><dd>{ORIGIN_LABEL[p.origin]}</dd>
              {p.dir && <><dt>Location</dt><dd className="settings-path">{p.dir}</dd></>}
              {p.catalog && <><dt>On HiveHub</dt><dd>{p.catalog.author} · {p.catalog.version} · every file checked against its checksum when installed</dd></>}
            </dl>
          </section>
        </>}
      </div>
    </div>
  );
}

/** For a member of a package of several: which, and that its switch waits on the package's. */
function PartOf({ p }: { p: PluginRecord }) {
  const go = useSettingsNavigate();
  const widget = useWidgetPackages().find((x) => x.id === p.id);
  const tool = useToolPackages().packages.find((x) => x.id === p.id && x.source === "you");
  const view = useCommunityReport().packages.find((x) => x.id === p.id);
  const of = p.kind === "widget" ? widget : p.kind === "tool" ? tool : p.kind === "view" ? view : undefined;
  const part = of && partOfPackage(of);
  if (!part) return null;
  return <p className="settings-note" data-part-of={part.id}>
    Part of <button type="button" className="settings-link" onClick={() => { showPackage(part.id); go("plugins"); }}>{part.name}</button>
    {heldOffByPackage(of) ? ", which is off: switch the package on first." : ". Installed, updated and removed with it."}
  </p>;
}

/** Its own mark, as the rest of the app draws it. */
function PluginMark({ p }: { p: PluginRecord }) {
  const widget = useWidgetPackages().find((x) => x.id === p.id);
  if (!p.installed) return p.catalog && (p.kind === "agent" || catalogImage(p.catalog.icon)) ? <CatalogMark entry={p.catalog} /> : <LayoutGrid size={20} />;
  if (p.kind === "agent") return <AgentMark id={p.id} />;
  if (p.kind === "view") return <ViewMark id={p.id} />;
  if (p.kind === "tool") return <ToolIcon pluginId={p.id} size={20} />;
  return <WidgetIcon pkg={widget} size={20} />;
}

/** What is done to it as a whole, on every tab: switching it on or off, making it the one used. */
function PluginActions({ p }: { p: PluginRecord }) {
  const widget = useWidgetPackages().find((x) => x.id === p.id);
  const on = isPluginOn(useSettings().plugins.state, "widget", widget ?? p);
  if (p.kind === "agent") return <AgentActions id={p.id} />;
  if (p.kind === "view") return <ViewActions id={p.id} />;
  if (p.kind === "tool") return <ToolActions id={p.id} />;
  return <Switch aria-label={`Enable ${p.name}`} checked={on} disabled={!!widget && heldOffByPackage(widget)} onCheckedChange={() => void switchPlugin("widget", widget ?? p, !on)} />;
}

/** A plugin's Settings tab: its kind's own controls, then the fields it declares. */
function PluginSettings({ p }: { p: PluginRecord }) {
  if (p.kind === "agent") return <AgentPage id={p.id} />;
  if (p.kind === "tool") return <ToolPage id={p.id} />;
  if (p.kind === "view") return <><ViewPage id={p.id} /><ViewDeclaredSettings id={p.id} /></>;
  return <WidgetSettings id={p.id} />;
}

/** What a community view declares in its manifest's `settings`, set here and sent to it live. */
function ViewDeclaredSettings({ id }: { id: string }) {
  const fields = useCommunityReport().packages.find((x) => x.id === id)?.manifest?.settings ?? [];
  const stored = useSettings().plugins.state;
  if (!fields.length) return null;
  return <section className="plugin-section" aria-label="Its settings" data-plugin-settings={`view:${id}`}>
    <h3>Its settings</h3>
    <SettingsForm fields={fields} values={resolveSettings(fields, pluginOptions(stored, "view", id))} onChange={(f, v) => setPluginOption("view", id, f, v)} />
  </section>;
}

/** A widget is switched on or off here; what each placed one shows is set on it, on the board. */
function WidgetSettings({ id }: { id: string }) {
  const w = useWidgetPackages().find((x) => x.id === id);
  const on = isPluginOn(useSettings().plugins.state, "widget", w ?? { id });
  if (!w) return null;
  return <div className="plugin-page" data-widget-page={id}>
    {!on && <p className="settings-note">Off: it is not offered to add, and the ones placed keep what they hold but do not run.</p>}
    {w.options.length > 0
      ? <p className="settings-note">Each one you place has its own {w.options.map((o) => o.label.toLowerCase()).join(", ")}: select it and use the settings button above it.</p>
      : <p className="settings-note">It has nothing to set.</p>}
    {!w.builtin && !partOfPackage(w) && <RemoveWidget id={id} name={w.name} />}
  </div>;
}

function RemoveWidget({ id, name }: { id: string; name: string }) {
  const go = useSettingsNavigate();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!asking) return <Button variant="ghost-destructive" className="mt-3 -ml-3" onClick={() => setAsking(true)}><Trash />Remove {name}</Button>;
  return <div className="settings-remove-confirm">
    <p>Remove {name}?</p>
    {error && <p role="alert" className="settings-note error">{error}</p>}
    <div className="settings-actions">
      <Button variant="outline" onClick={() => setAsking(false)}>Keep it</Button>
      <Button variant="destructive" onClick={() => void window.hive.removeWidget(id).then(() => go("plugins"), (e) => setError(cleanError(e)))}>Remove</Button>
    </div>
  </div>;
}
