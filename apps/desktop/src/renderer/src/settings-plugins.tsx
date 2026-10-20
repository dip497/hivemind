import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { setViewMode } from "./workspace/view-mode-store";
import { Blocks, ChevronDown, ChevronRight, LayoutGrid } from "./components/icons";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { iconFromManifest } from "@hivemind/agents";
import { Button } from "./components/ui/button";
import { Loading } from "./components/ui/loading";
import { useCommunityReport } from "./workspace/views/community/registry";
import { syncAgentPlugins, useAgentEntries } from "./agent-plugins";
import { SvgMark } from "./agents";
import { rescan } from "./settings-views";
import { permissionWords } from "./plugins/library";
import { rowsInKindTab, TAB_LABEL, type PluginTab } from "./plugins/kinds";
import { MemberIcon, MEMBER_KIND, PackageReview, RUNS_LABEL, askedFor } from "./plugins/PackageReview";
import { memberFormat } from "@hivemind/hub";
import { CategoryGroups, KindTabs, PluginRow, type ListedRow } from "./plugins/PluginList";
import { useWidgetPackages } from "./board-objects/widget-runtime";
import { useToolPackages } from "./tiles/tool-plugins";
import { useSettingsNavigate } from "./settings-panels";

export const cleanError = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "The plugin could not be updated.";

type Entry = Awaited<ReturnType<typeof window.hive.pluginCatalog>>[number];
type Review = Awaited<ReturnType<typeof window.hive.reviewCatalogPlugin>>;

/** Numeric dotted compare; anything unparsable counts as equal. */
type Skipped = Awaited<ReturnType<typeof window.hive.pluginCatalogSkipped>>[number];

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * An agent's mark in the catalog list: its manifest's own icon when the entry carries one,
 * sanitised here because this is where it is drawn. Otherwise a monogram — a column of
 * identical glyphs tells you nothing, and drawing someone's logo for them is worse.
 */
export function CatalogMark({ entry }: { entry: Pick<Entry, "id" | "icon"> }) {
  const icon = useMemo(() => {
    try { return entry.icon ? iconFromManifest(entry.icon as Parameters<typeof iconFromManifest>[0]) : null; }
    catch { return null; } // a mark we cannot read is a mark we do not draw
  }, [entry.icon]);
  if (icon) return <SvgMark icon={icon} size={20} />;
  let hue = 0;
  for (const c of entry.id) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return <span className="catalog-monogram" style={{ "--mark-hue": hue } as CSSProperties}>{entry.id[0]?.toUpperCase()}</span>;
}

/** What HiveHub lists, found by the Plugins page's search, the open tab's kind under its
 *  categories; each one installed after its review, here or on its own page. */
export function BrowsePlugins({ query, tab, onTab }: { query: string; tab: PluginTab; onTab: (tab: PluginTab) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [review, setReview] = useState<{ key: string; data: Review } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [done, setDone] = useState<{ entry: Entry } | null>(null);
  const [outdated, setOutdated] = useState<string[]>([]);
  const [holding, setHolding] = useState<string | null>(null);
  const reviewRef = useRef<HTMLElement | null>(null);
  const views = useCommunityReport().packages;
  const agents = useAgentEntries();
  const widgets = useWidgetPackages();
  const tools = useToolPackages().packages;
  const go = useSettingsNavigate();
  const load = () => {
    setLoadError(null); setEntries(null);
    window.hive.pluginCatalog().then((list) => {
      setEntries(list);
      // Only meaningful once the catalog is loaded — it is what the installed copies are
      // compared against.
      window.hive.outdatedAgents().then(setOutdated, () => setOutdated([]));
      window.hive.pluginCatalogSkipped().then(setSkipped, () => setSkipped([]));
    }, (e) => setLoadError(cleanError(e)));
  };
  useEffect(load, []);
  useEffect(rescan, []);

  // A package is installed when one of its members is, under it.
  const packageVersion = (id: string): string | null =>
    [...views.map((v) => v.package), ...widgets.map((w) => w.package), ...tools.map((t) => t.package)].find((p) => p?.id === id)?.version ?? null;
  const installed = (e: Entry): string | null =>
    e.type === "package" ? packageVersion(e.id)
    : e.type === "view" ? views.find((v) => v.id === e.id)?.manifest?.version ?? null
    // A widget that says no version is older than any listed one.
    : e.type === "widget" ? (widgets.some((w) => w.id === e.id) ? widgets.find((w) => w.id === e.id)!.version ?? "0.0.0" : null)
    : e.type === "tool" ? (tools.some((t) => t.id === e.id && t.source === "you") ? tools.find((t) => t.id === e.id && t.source === "you")!.version ?? "0.0.0" : null)
    : agents.some((a) => a.id === e.id && a.source === "user") ? "installed" : null;
  const q = query.trim().toLowerCase();
  const shown = (entries ?? []).filter((e) => !q || `${e.name} ${e.description} ${e.author}`.toLowerCase().includes(q));
  const key = (e: Entry) => `${e.type}:${e.id}`;
  // A view says which version it is; an agent does not, so what it has is compared by content
  // instead — the same hash the catalog pins it by.
  const outdatedOf = (e: Entry): boolean => {
    const have = installed(e);
    return e.type === "agent" ? outdated.includes(e.id) : !!have && newer(e.version, have);
  };

  const startReview = async (e: Entry) => {
    setBusy(key(e)); setError(null); setDone(null); setReview(null);
    try {
      setReview({ key: key(e), data: await window.hive.reviewCatalogPlugin(e.type, e.id) });
      requestAnimationFrame(() => reviewRef.current?.focus());
    }
    catch (err) { setError({ key: key(e), message: cleanError(err) }); }
    finally { setBusy(null); }
  };
  const install = async (e: Entry, r: Review) => {
    setBusy(key(e)); setError(null);
    try {
      if (r.type === "view") { await window.hive.installViewPackage(r.token); rescan(); }
      else if (r.type === "widget") await window.hive.installCatalogWidget(r.token);
      else if (r.type === "tool") await window.hive.installCatalogTool(r.token);
      else if (r.type === "package") { await window.hive.installCatalogPackage(r.token); rescan(); }
      else { await window.hive.installCatalogAgent(r.token); await syncAgentPlugins(); }
      setReview(null);
      setDone({ entry: e });
    } catch (err) { setError({ key: key(e), message: cleanError(err) }); }
    finally { setBusy(null); }
  };

  const reviewOf = (e: Entry, open: Review) => <section ref={reviewRef} tabIndex={-1} className="settings-install-review" aria-label={`Review ${e.name}`}>
    {open.type === "widget" ? <>
      <p>Adds {open.name}, a widget you put in a workspace from the toolbar's Add menu. {open.code
        ? "Its code runs in a worker that cannot reach the internet or your files; it hands the app what to draw."
        : "It has no code: the app draws it from its description."}</p>
      <p>{open.permissions.length ? <>It may also: {permissionWords(open.permissions).join("; ")}.</> : "It asks for nothing beyond showing itself and what it keeps."}</p>
      {open.replaces && <p className="settings-note">Replaces the {open.name} you installed before. What each placed one holds is kept.</p>}
    </> : open.type === "tool" ? <>
      <p>Adds {open.name}: {open.tools.join(", ")}, opened from a frame or the Add menu. It runs inside Hivemind with the app's access to your files and network, so it is installed switched off. Switch it on from its page once you trust who wrote it.</p>
      <p>{open.permissions.length ? <>Its tiles may also: {permissionWords(open.permissions).join("; ")}.</> : "Its tiles ask for nothing more."}</p>
      {open.service && <p>While it is on, it keeps this running: <code className="catalog-flag">{open.service}</code></p>}
      {open.replacesVersion && <p className="settings-note">Replaces version {open.replacesVersion}. Like any update to a tool, it is switched off until you switch it on again.</p>}
    </> : open.type === "package" ? <PackageReview review={open} />
    : open.type === "view" ? <>
      <p>This view can show workspace names and agent status, and open your existing tools.</p>
      <p>{open.package.manifest?.permissions.length ? `Additional access: ${open.package.manifest.permissions.join(", ")}` : "No additional access requested."}</p>
      {open.replacesVersion && <p className="settings-note">Replaces version {open.replacesVersion}. Your saved layout is kept.</p>}
    </> : <>
      <p>Adds {open.label}. Each launch runs this in a terminal tile{open.worker ? "" : "; other agents cannot collect its replies"}:</p>
      <pre className="catalog-command"><code>{open.command}</code></pre>
      {open.flags.length > 0 && <p>Its launch options can add: {open.flags.map((f) => <code key={f} className="catalog-flag">{f}</code>)}</p>}
      {open.does.length > 0 && <ul className="catalog-does">{open.does.map((d) => <li key={d}>{d}</li>)}</ul>}
      <p>No code is installed — it runs the <code>{open.bin}</code> you install yourself.{open.install && <> Get it from <a href={open.install.url} target="_blank" rel="noreferrer">its install page</a>.</>}</p>
      {open.replaces && <p className="settings-note">Replaces the {open.label} you installed before.</p>}
    </>}
    <p className="settings-note">Every file matches the checksum in the catalog index. The index itself is not signed, so install only what you trust.</p>
    <div className="settings-actions">
      <Button variant="outline" disabled={busy === key(e)} onClick={() => setReview(null)}>Cancel</Button>
      <Button disabled={busy === key(e)} onClick={() => void install(e, open)}>{busy === key(e) ? "Installing…" : outdatedOf(e) ? "Update" : "Install"}</Button>
    </div>
  </section>;

  const { counts, groups } = rowsInKindTab(shown.map((e): ListedRow => {
    const have = installed(e);
    const update = outdatedOf(e);
    const open = review?.key === key(e) ? review.data : null;
    const action = (!have || update) && !open ? <Button size="xs" variant="outline" disabled={busy === key(e)} onClick={() => void startReview(e)}>
      {busy === key(e) ? "Checking…" : update ? "Update" : "Install"}</Button> : undefined;
    return { key: key(e), kind: e.type, category: e.category ?? "other", row: <div className="catalog-item" data-catalog-plugin={key(e)}>
      {e.type === "package"
        ? <CatalogPackageRow entry={e} installed={!!have && !update} action={action} open={holding === e.id} toggle={() => setHolding(holding === e.id ? null : e.id)} />
        : <PluginRow kind={e.type} id={e.id} name={e.name} line={e.description} mark={e.type === "agent" ? <CatalogMark entry={e} /> : <LayoutGrid size={16} />}
          badge={have && !update ? "Installed" : undefined} action={action} />}
      {error?.key === key(e) && <p role="alert" className="settings-note error">{error.message}</p>}
      {open && reviewOf(e, open)}
    </div> };
  }), tab);

  return <div className="settings-stack">
    {done && <div role="status" className="settings-message catalog-done">
      <span>{done.entry.name} is installed.</span>
      {done.entry.type === "package" ? null
        : done.entry.type === "view"
        ? <Button onClick={() => { setViewMode(done.entry.id); go(`plugin:view:${done.entry.id}`); }}>Use this view</Button>
        : <Button onClick={() => go(`plugin:${done.entry.type}:${done.entry.id}`)}>Open its page</Button>}
    </div>}
    {loadError && <div role="alert" className="settings-message error">
      <p>Could not load the plugin catalog: {loadError}</p>
      <div className="settings-actions"><Button variant="outline" onClick={load}>Try again</Button></div>
    </div>}
    {!entries && !loadError && <Loading label="Loading the catalog" />}
    {entries && <KindTabs counts={counts} tab={tab} onChange={onTab} />}
    {entries && !groups.length && <p className="settings-empty">
      {q ? <>No {TAB_LABEL[tab].toLowerCase()} on HiveHub match “{query}”.</> : `No ${TAB_LABEL[tab].toLowerCase()} have been published yet.`}
    </p>}
    <CategoryGroups groups={groups} />
    {entries && skipped.length > 0 && <SkippedEntries skipped={skipped} />}
    <p className="settings-note">Every file is checked against HiveHub's checksum.</p>
  </div>;
}

/** What HiveHub lists that this Hivemind cannot read, one line each with why, so a missing plugin
 *  is not a mystery. A newer Hivemind may read them. */
function SkippedEntries({ skipped }: { skipped: Skipped[] }) {
  return <Alert data-catalog-skipped>
    <AlertTitle>{skipped.length === 1 ? "1 plugin on HiveHub is not shown" : `${skipped.length} plugins on HiveHub are not shown`}</AlertTitle>
    <AlertDescription>
      <p>This Hivemind cannot read their entries. A newer Hivemind may.</p>
      {skipped.map((s) => <p key={`${s.position}:${s.id ?? ""}`} data-catalog-skipped-entry={s.id ?? s.position}>
        {s.id ?? `Entry ${s.position + 1}`}: {s.reason}
      </p>)}
    </AlertDescription>
  </Alert>;
}

/** A package HiveHub lists: one row, opened to what it holds as HiveHub read it, before anything
 *  is downloaded. The review checks every member again from its files. */
function CatalogPackageRow({ entry: e, installed, action, open, toggle }: { entry: Entry; installed: boolean; action: ReactNode; open: boolean; toggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return <>
    <div className="plugin-row catalog-package-row" data-plugin-row={`package:${e.id}`}>
      <span className="plugin-row-mark" aria-hidden="true"><Blocks size={16} /></span>
      <span className="plugin-row-text">
        <span className="plugin-row-name">{e.name}</span>
        {e.description && <span className="plugin-row-detail">{e.description}</span>}
      </span>
      {action ?? (installed && <span className="plugin-row-detail">Installed</span>)}
    </div>
    {e.members && <button type="button" className="catalog-holds-toggle" aria-expanded={open} onClick={toggle} data-package-holds-open={e.id}>
      <Chevron size={13} />What it holds ({e.members.length})</button>}
    {open && e.members && <ul className="package-review-list catalog-holds" data-package-holds={e.id}>
      {e.members.map((m) => <li key={`${m.kind}:${m.id}`} className="package-review-member">
        <span className="plugin-row-mark" aria-hidden="true"><MemberIcon kind={m.kind} /></span>
        <span className="plugin-row-text">
          <span className="plugin-row-name">{m.name}</span>
          <span className="plugin-row-detail">{MEMBER_KIND[m.kind] ?? m.kind}{memberFormat(m.kind) ? ` · ${RUNS_LABEL[memberFormat(m.kind)!.runs]}` : ""}</span>
          <span className="package-review-asks">{m.permissions.length ? `May ${askedFor(m.permissions).join("; ")}` : "Asks for nothing more"}</span>
        </span>
      </li>)}
    </ul>}
  </>;
}
