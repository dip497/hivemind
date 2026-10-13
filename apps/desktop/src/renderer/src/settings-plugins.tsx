import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { setViewMode } from "./workspace/view-mode-store";
import { Check, ExternalLink, LayoutGrid, RefreshCw } from "./components/icons";
import { iconFromManifest } from "@hivemind/agents";
import { Button } from "./components/ui/button";
import { Loading } from "./components/ui/loading";
import { useCommunityReport } from "./workspace/views/community/registry";
import { syncAgentPlugins, useAgentEntries } from "./agent-plugins";
import { SvgMark } from "./agents";
import { rescan } from "./settings-views";
import { KIND_LABEL, permissionWords, type PluginKind } from "./plugins/library";
import { useWidgetPackages } from "./board-objects/widget-runtime";
import { useSettingsNavigate } from "./settings-panels";

export type Preview = NonNullable<Awaited<ReturnType<NonNullable<typeof window.hive.previewViewInstall>>>>;

export const cleanError = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "The plugin could not be updated.";

type Entry = Awaited<ReturnType<typeof window.hive.pluginCatalog>>[number];
type Review = Awaited<ReturnType<typeof window.hive.reviewCatalogPlugin>>;

/** Numeric dotted compare; anything unparsable counts as equal. */
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
function CatalogMark({ entry }: { entry: Entry }) {
  const icon = useMemo(() => {
    try { return entry.icon ? iconFromManifest(entry.icon as Parameters<typeof iconFromManifest>[0]) : null; }
    catch { return null; } // a mark we cannot read is a mark we do not draw
  }, [entry.icon]);
  if (icon) return <SvgMark icon={icon} size={20} />;
  let hue = 0;
  for (const c of entry.id) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return <span className="catalog-monogram" style={{ "--mark-hue": hue } as CSSProperties}>{entry.id[0]?.toUpperCase()}</span>;
}

/** What HiveHub lists, filtered by the Plugins page's search and kind; each one installed after
 *  its review, here or on its own page. */
export function BrowsePlugins({ query, kind }: { query: string; kind: "all" | PluginKind }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [review, setReview] = useState<{ key: string; data: Review } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [done, setDone] = useState<{ entry: Entry } | null>(null);
  const [outdated, setOutdated] = useState<string[]>([]);
  const reviewRef = useRef<HTMLElement | null>(null);
  const views = useCommunityReport().packages;
  const agents = useAgentEntries();
  const widgets = useWidgetPackages();
  const go = useSettingsNavigate();
  const load = () => {
    setLoadError(null); setEntries(null);
    window.hive.pluginCatalog().then((list) => {
      setEntries(list);
      // Only meaningful once the catalog is loaded — it is what the installed copies are
      // compared against.
      window.hive.outdatedAgents().then(setOutdated, () => setOutdated([]));
    }, (e) => setLoadError(cleanError(e)));
  };
  useEffect(load, []);
  useEffect(rescan, []);

  const installed = (e: Entry): string | null =>
    e.type === "view" ? views.find((v) => v.id === e.id)?.manifest?.version ?? null
    // A widget that says no version is older than any listed one.
    : e.type === "widget" ? (widgets.some((w) => w.id === e.id) ? widgets.find((w) => w.id === e.id)!.version ?? "0.0.0" : null)
    : agents.some((a) => a.id === e.id && a.source === "user") ? "installed" : null;
  const q = query.trim().toLowerCase();
  const shown = (entries ?? []).filter((e) => (kind === "all" || e.type === kind)
    && (!q || `${e.name} ${e.description} ${e.author}`.toLowerCase().includes(q)));
  const key = (e: Entry) => `${e.type}:${e.id}`;

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
      else { await window.hive.installCatalogAgent(r.token); await syncAgentPlugins(); }
      setReview(null);
      setDone({ entry: e });
    } catch (err) { setError({ key: key(e), message: cleanError(err) }); }
    finally { setBusy(null); }
  };

  return <div className="settings-stack">
    <div className="catalog-bar justify-end">
      <Button variant="ghost" size="icon-sm" aria-label="Refresh catalog" onClick={load}><RefreshCw /></Button>
    </div>
    {done && <div role="status" className="settings-message catalog-done">
      <span>{done.entry.name} is installed.</span>
      {done.entry.type === "view"
        ? <Button size="sm" onClick={() => { setViewMode(done.entry.id); go(`plugin:view:${done.entry.id}`); }}>Use this view</Button>
        : <Button size="sm" onClick={() => go(`plugin:${done.entry.type}:${done.entry.id}`)}>Open its page</Button>}
    </div>}
    {loadError && <div role="alert" className="settings-message error">
      <p>Could not load the plugin catalog: {loadError}</p>
      <div className="settings-actions"><Button size="sm" variant="outline" onClick={load}>Try again</Button></div>
    </div>}
    {!entries && !loadError && <Loading label="Loading the catalog" />}
    {entries && !shown.length && <p className="settings-empty">
      {q ? <>No plugins on HiveHub match “{query}”.</>
        : kind !== "all" ? `No ${kind} plugins have been published yet.` : "Nothing has been published yet."}
    </p>}
    <div className="catalog-list">
      {shown.map((e) => {
        const have = installed(e);
        // A view says which version it is; an agent does not, so what it has is compared by
        // content instead — the same hash the catalog pins it by.
        const update = e.type === "agent" ? outdated.includes(e.id) : !!have && newer(e.version, have);
        const open = review?.key === key(e) ? review.data : null;
        return <article key={key(e)} className="catalog-entry" data-catalog-plugin={key(e)}>
          <div className="catalog-entry-row">
            <div className="catalog-entry-icon" aria-hidden="true">{e.type === "agent" ? <CatalogMark entry={e} /> : <LayoutGrid size={20} />}</div>
            <div className="catalog-entry-text">
              <h4><button type="button" className="plugin-name-link" data-plugin-open={key(e)} onClick={() => go(`plugin:${e.type}:${e.id}`)}>{e.name}</button> <span className="catalog-type">{KIND_LABEL[e.type]}</span></h4>
              <p className="catalog-meta">{e.author}<span>·</span>{e.version}{e.homepage && <><span>·</span><a href={e.homepage} target="_blank" rel="noreferrer">Source<ExternalLink size={11} /></a></>}</p>
              <p className="catalog-description">{e.description}</p>
              {e.type === "agent" && e.bin && <p className="catalog-meta">Runs the <code>{e.bin}</code> command, which you install yourself</p>}
            </div>
            {have && !update
              ? <span className="catalog-installed"><Check size={13} />Installed</span>
              : !open && <Button size="sm" disabled={busy === key(e)} onClick={() => void startReview(e)}>
                  {busy === key(e) && !open ? "Checking…" : update ? "Update" : "Install"}</Button>}
          </div>
          {error?.key === key(e) && <p role="alert" className="settings-note error">{error.message}</p>}
          {open && <section ref={reviewRef} tabIndex={-1} className="settings-install-review" aria-label={`Review ${e.name}`}>
            {open.type === "widget" ? <>
              <p>Adds {open.name}, a widget you put in a workspace from the toolbar's Add menu. {open.code
                ? "Its code runs in a worker that cannot reach the internet or your files; it hands the app what to draw."
                : "It has no code: the app draws it from its description."}</p>
              <p>{open.permissions.length ? <>It may also: {permissionWords(open.permissions).join("; ")}.</> : "It asks for nothing beyond showing itself and what it keeps."}</p>
              {open.replaces && <p className="settings-note">Replaces the {open.name} you installed before. What each placed one holds is kept.</p>}
            </> : open.type === "view" ? <>
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
              <Button size="sm" variant="outline" disabled={busy === key(e)} onClick={() => setReview(null)}>Cancel</Button>
              <Button size="sm" disabled={busy === key(e)} onClick={() => void install(e, open)}>{busy === key(e) ? "Installing…" : update ? "Update" : "Install"}</Button>
            </div>
          </section>}
        </article>;
      })}
    </div>
    <p className="settings-note">Plugins come from HiveHub, with a checksum for every file. A view is named <code>@owner/name</code> after the account that published it; an agent has one name, like <code>gemini</code>.</p>
  </div>;
}
