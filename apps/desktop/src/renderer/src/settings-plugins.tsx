import { useEffect, useRef, useState } from "react";
import { setViewMode } from "./workspace/view-mode-store";
import { Check, ChevronDown, ChevronRight, ExternalLink, FolderPlus, LayoutGrid, RefreshCw, Trash2 } from "lucide-react";
import { BUILTIN_CATALOG, GENERIC_AGENT_ICON, defFromManifest } from "@hivemind/agents";
import { getSettings, patchSettings, useSettings } from "./settings-store";
import { useCommunityReport } from "./workspace/views/community/registry";
import { syncAgentPlugins, useAgentEntries } from "./agent-plugins";
import { SvgMark } from "./agents";
import { PackageRow, rescan } from "./settings-views";
import { useSettingsNavigate } from "./settings-panels";

type Preview = NonNullable<Awaited<ReturnType<typeof window.hive.previewViewInstall>>>;

const cleanError = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "The plugin could not be updated.";

export function InstalledPlugins() {
  const report = useCommunityReport();
  const settings = useSettings();
  const agents = useAgentEntries().filter((e) => e.source !== "builtin");
  const go = useSettingsNavigate();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(rescan, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(cleanError(e)); }
    finally { setBusy(false); }
  };
  return <div className="settings-stack">
    <div className="settings-section-heading settings-extension-intro">
      <h3>Views</h3>
      <div className="settings-inline">
        <button className="settings-icon-button" aria-label="Refresh plugins" onClick={rescan}><RefreshCw size={14} /></button>
        <button className="settings-button" disabled={busy} onClick={() => void act(async () => setPreview(await window.hive.previewViewInstall()))}><FolderPlus size={15} />Install from folder</button>
      </div>
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
        setNotice(`${preview.package.manifest?.name} installed. Choose it under Views when you’re ready.`); setPreview(null); rescan();
      })}>{busy ? "Installing…" : preview.replacesVersion ? "Replace extension" : "Install extension"}</button></div>
    </section>}
    <section aria-label="Installed views">
      {!report.packages.length && <p className="settings-empty">No views added yet.</p>}
      <div className="settings-extension-list">
        {report.packages.map((pkg) => {
          const enabled = !settings.plugins.disabled.includes(pkg.id);
          const refused = report.refused[pkg.id];
          const problem = refused && refused !== "disabled in Settings" ? refused : null;
          return <PackageRow
            key={`${pkg.source}:${pkg.dir}`}
            testAttr={{ "data-community-pkg": pkg.id }}
            title={pkg.manifest?.name ?? pkg.id}
            subtitle={<>{pkg.manifest?.version ?? "Invalid package"}<span>·</span>{problem ? "Unavailable" : enabled ? "Enabled" : "Disabled"}</>}
            enabled={enabled}
            toggleDisabled={busy || !!pkg.error}
            onToggle={() => {
              const disabled = getSettings().plugins.disabled;
              patchSettings("plugins.disabled", enabled ? [...new Set([...disabled, pkg.id])] : disabled.filter((id) => id !== pkg.id)); rescan();
            }}
            footer={<>
              {problem && <p role="status" className="settings-note error">{problem}</p>}
              <details><summary>Details <ChevronDown size={12} /></summary>
                <dl><dt>Available to</dt><dd>{pkg.source === "user" ? "All your workspaces" : "This repository"}</dd><dt>Location</dt><dd className="settings-path">{pkg.dir}</dd><dt>Additional access</dt><dd>{pkg.manifest?.permissions.join(", ") || "None"}</dd></dl>
                {pkg.source === "user" ? removing === pkg.id ? <div className="settings-remove-confirm"><p>Remove {pkg.manifest?.name ?? pkg.id}? Its saved layout will be kept.</p><div className="settings-actions"><button className="settings-button" disabled={busy} onClick={() => setRemoving(null)}>Keep extension</button><button className="settings-button danger" disabled={busy} onClick={() => void act(async () => { await window.hive.removeViewPackage(pkg.id); setRemoving(null); rescan(); setNotice("Extension removed. Your work is still running."); })}>Remove extension</button></div></div> : <button className="settings-text-button danger" disabled={busy} onClick={() => setRemoving(pkg.id)}><Trash2 size={13} />Remove extension</button> : <p className="settings-note">Included by this repository. Disable it here to stop using it.</p>}
              </details>
            </>}
          />;
        })}
      </div>
    </section>
    <section aria-label="Installed agents">
      <div className="settings-section-heading"><h3>Agents</h3></div>
      {!agents.length && <p className="settings-empty">No agents added yet.</p>}
      <div className="settings-extension-list">
        {agents.map((e) => {
          let def;
          try { def = e.error ? undefined : defFromManifest(e.manifest); } catch { def = undefined; }
          const shadows = BUILTIN_CATALOG.some((b) => b.id === e.id);
          return <div key={`${e.source}:${e.id}`} className="settings-extension" data-agent-package={e.id}>
            <div className="settings-extension-row">
              <div className="settings-extension-icon"><SvgMark icon={def?.icon ?? GENERIC_AGENT_ICON} size={19} /></div>
              <div className="settings-extension-label"><h4>{def?.label ?? e.id}</h4>
                <p>{e.source === "user" ? "Added on this machine" : "From this repository"}<span>·</span>{e.error ? "Unavailable" : e.disabled ? "Off" : shadows ? "Replaces the built-in" : "On"}</p></div>
              <button className="settings-icon-button" aria-label={`${def?.label ?? e.id} settings`} onClick={() => go(`agent:${e.id}`)}><ChevronRight size={15} /></button>
            </div>
            {e.error && <p role="status" className="settings-note error">{e.error}</p>}
          </div>;
        })}
      </div>
    </section>
    <details className="settings-developer-details"><summary>Add with the CLI <ChevronDown size={12} /></summary>
      <p>The desktop and the CLI share one plugin library.</p>
      <code>hive views install &lt;folder&gt;</code>
      <code>hive agents install &lt;folder&gt;</code>
      <p>A view folder holds a built <code>hivemind-view.json</code> and its assets; an agent folder holds <code>agent.yaml</code>.</p>
    </details>
  </div>;
}

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

export function BrowsePlugins() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | Entry["type"]>("all");
  const [review, setReview] = useState<{ key: string; data: Review } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [done, setDone] = useState<{ entry: Entry } | null>(null);
  const reviewRef = useRef<HTMLElement | null>(null);
  const views = useCommunityReport().packages;
  const agents = useAgentEntries();
  const go = useSettingsNavigate();
  const load = () => {
    setLoadError(null); setEntries(null);
    window.hive.pluginCatalog().then(setEntries, (e) => setLoadError(cleanError(e)));
  };
  useEffect(load, []);
  useEffect(rescan, []);

  const installed = (e: Entry): string | null =>
    e.type === "view" ? views.find((v) => v.id === e.id)?.manifest?.version ?? null
    : agents.some((a) => a.id === e.id && a.source === "user") ? "installed" : null;
  const q = query.trim().toLowerCase();
  const shown = (entries ?? []).filter((e) => (type === "all" || e.type === type)
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
      else { await window.hive.installCatalogAgent(r.token); await syncAgentPlugins(); }
      setReview(null);
      setDone({ entry: e });
    } catch (err) { setError({ key: key(e), message: cleanError(err) }); }
    finally { setBusy(null); }
  };

  return <div className="settings-stack">
    <div className="catalog-bar">
      <input className="catalog-search" type="search" placeholder="Search plugins" aria-label="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="catalog-filters" role="group" aria-label="Plugin type">
        {(["all", "agent", "view"] as const).map((t) => (
          <button key={t} aria-pressed={type === t} className="agent-pill" onClick={() => setType(t)}>{t === "all" ? "All" : t === "agent" ? "Agents" : "Views"}</button>
        ))}
      </div>
      <button className="settings-icon-button" aria-label="Refresh catalog" onClick={load}><RefreshCw size={14} /></button>
    </div>
    {done && <div role="status" className="settings-message catalog-done">
      <span>{done.entry.name} is installed.</span>
      {done.entry.type === "view"
        ? <button className="settings-button primary" onClick={() => { setViewMode(done.entry.id); go(`view:${done.entry.id}`); }}>Use this view</button>
        : <button className="settings-button primary" onClick={() => go(`agent:${done.entry.id}`)}>Open its settings</button>}
    </div>}
    {loadError && <div role="alert" className="settings-message error">
      <p>Could not load the plugin catalog: {loadError}</p>
      <div className="settings-actions"><button className="settings-button" onClick={load}>Try again</button></div>
    </div>}
    {!entries && !loadError && <p role="status" className="settings-note">Loading the catalog…</p>}
    {entries && !shown.length && <p className="settings-empty">
      {q ? <>No plugins match “{query}”. <button className="settings-link" onClick={() => setQuery("")}>Clear the search</button></>
        : type !== "all" ? `No ${type} plugins have been published yet.` : "Nothing has been published yet."}
    </p>}
    <div className="catalog-list">
      {shown.map((e) => {
        const have = installed(e);
        const update = have && have !== "installed" && newer(e.version, have);
        const open = review?.key === key(e) ? review.data : null;
        return <article key={key(e)} className="catalog-entry" data-catalog-plugin={key(e)}>
          <div className="catalog-entry-row">
            <div className="catalog-entry-icon" aria-hidden="true">{e.type === "agent" ? <SvgMark icon={GENERIC_AGENT_ICON} size={20} /> : <LayoutGrid size={20} strokeWidth={1.6} />}</div>
            <div className="catalog-entry-text">
              <h4>{e.name} <span className="catalog-type">{e.type === "agent" ? "Agent" : "View"}</span></h4>
              <p className="catalog-meta">{e.author}<span>·</span>{e.version}{e.homepage && <><span>·</span><a href={e.homepage} target="_blank" rel="noreferrer">Source<ExternalLink size={11} /></a></>}</p>
              <p className="catalog-description">{e.description}</p>
              {e.type === "agent" && e.bin && <p className="catalog-meta">Runs the <code>{e.bin}</code> command, which you install yourself</p>}
            </div>
            {have && !update
              ? <span className="catalog-installed"><Check size={13} />Installed</span>
              : !open && <button className="settings-button primary" disabled={busy === key(e)} onClick={() => void startReview(e)}>
                  {busy === key(e) && !open ? "Checking…" : update ? "Update" : "Install"}</button>}
          </div>
          {error?.key === key(e) && <p role="alert" className="settings-note error">{error.message}</p>}
          {open && <section ref={reviewRef} tabIndex={-1} className="settings-install-review" aria-label={`Review ${e.name}`}>
            {open.type === "view" ? <>
              <p>This view can show workspace names and agent status, and open your existing tools.</p>
              <p>{open.package.manifest?.permissions.length ? `Additional access: ${open.package.manifest.permissions.join(", ")}` : "No additional access requested."}</p>
              {open.replacesVersion && <p className="settings-note">Replaces version {open.replacesVersion}. Your saved layout is kept.</p>}
            </> : <>
              <p>Adds {open.label}. Each launch runs this in a terminal tile{open.worker ? "" : "; other agents cannot collect its replies"}:</p>
              <pre className="catalog-command"><code>{open.command}</code></pre>
              {open.flags.length > 0 && <p>Its launch options can add: {open.flags.map((f) => <code key={f} className="catalog-flag">{f}</code>)}</p>}
              <p>No code is installed — it runs the <code>{open.bin}</code> you install yourself.{open.install && <> Get it from <a href={open.install.url} target="_blank" rel="noreferrer">its install page</a>.</>}</p>
              {open.replaces && <p className="settings-note">Replaces the {open.label} you installed before.</p>}
            </>}
            <p className="settings-note">Every file matches the checksum in the catalog index. The index itself is not signed, so install only what you trust.</p>
            <div className="settings-actions">
              <button className="settings-button" disabled={busy === key(e)} onClick={() => setReview(null)}>Cancel</button>
              <button className="settings-button primary" disabled={busy === key(e)} onClick={() => void install(e, open)}>{busy === key(e) ? "Installing…" : update ? "Update" : "Install"}</button>
            </div>
          </section>}
        </article>;
      })}
    </div>
    <p className="settings-note">Plugins are listed in <code>plugins/index.json</code> of the Hivemind repository, with a checksum for every file. To add one from your own folder, see{" "}
      <button className="settings-link" onClick={() => go("installed")}>Installed plugins</button>.</p>
  </div>;
}
