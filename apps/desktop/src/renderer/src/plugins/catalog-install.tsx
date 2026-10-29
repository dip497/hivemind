/**
 * Installing from HiveHub, wherever it is asked for (Settings ▸ Plugins ▸ HiveHub, the Add menu):
 * what is installed already, the review a person reads first, and the install itself.
 */
import { useRef, useState, type RefObject } from "react";
import { Button } from "../components/ui/button";
import { useCommunityReport } from "../workspace/views/community/registry";
import { syncAgentPlugins, useAgentEntries } from "../agent-plugins";
import { rescan } from "../settings-views";
import { permissionWords } from "./library";
import { PackageReview } from "./PackageReview";
import { useWidgetPackages } from "../board-objects/widget-runtime";
import { useToolPackages } from "../tiles/tool-plugins";
import { useWallpapers } from "../live/wallpaper-store";

export type CatalogEntry = Awaited<ReturnType<typeof window.hive.pluginCatalog>>[number];
export type CatalogReview = Awaited<ReturnType<typeof window.hive.reviewCatalogPlugin>>;

export const cleanError = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "The plugin could not be updated.";

export const catalogKey = (e: Pick<CatalogEntry, "type" | "id">) => `${e.type}:${e.id}`;

/** The version of a HiveHub entry installed here, "installed" for an agent, or null. */
export function useInstalledVersion(): (e: CatalogEntry) => string | null {
  const views = useCommunityReport().packages;
  const agents = useAgentEntries();
  const widgets = useWidgetPackages();
  const tools = useToolPackages().packages;
  const wallpapers = useWallpapers().wallpapers;
  // A package is installed when one of its members is, under it.
  const packageVersion = (id: string): string | null =>
    [...views.map((v) => v.package), ...widgets.map((w) => w.package), ...tools.map((t) => t.package), ...wallpapers.map((w) => w.package)].find((p) => p?.id === id)?.version ?? null;
  return (e) =>
    e.type === "package" ? packageVersion(e.id)
    : e.type === "view" ? views.find((v) => v.id === e.id)?.manifest?.version ?? null
    // A widget that says no version is older than any listed one.
    : e.type === "widget" ? (widgets.some((w) => w.id === e.id) ? widgets.find((w) => w.id === e.id)!.version ?? "0.0.0" : null)
    : e.type === "tool" ? (tools.some((t) => t.id === e.id && t.source === "you") ? tools.find((t) => t.id === e.id && t.source === "you")!.version ?? "0.0.0" : null)
    : agents.some((a) => a.id === e.id && a.source === "user") ? "installed" : null;
}

/** One entry at a time: fetch and check its files for the review, then install what was reviewed.
 *  A tool or a widget that runs code arrives switched off; the person switches it on from its page. */
export function useCatalogInstall() {
  const [review, setReview] = useState<{ key: string; data: CatalogReview } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [done, setDone] = useState<{ entry: CatalogEntry; review: CatalogReview } | null>(null);
  const reviewRef = useRef<HTMLElement | null>(null);
  const startReview = async (e: CatalogEntry) => {
    setBusy(catalogKey(e)); setError(null); setDone(null); setReview(null);
    try {
      setReview({ key: catalogKey(e), data: await window.hive.reviewCatalogPlugin(e.type, e.id) });
      requestAnimationFrame(() => reviewRef.current?.focus());
    }
    catch (err) { setError({ key: catalogKey(e), message: cleanError(err) }); }
    finally { setBusy(null); }
  };
  const install = async (e: CatalogEntry, r: CatalogReview) => {
    setBusy(catalogKey(e)); setError(null);
    try {
      if (r.type === "view") { await window.hive.installViewPackage(r.token); rescan(); }
      else if (r.type === "widget") await window.hive.installCatalogWidget(r.token);
      else if (r.type === "tool") await window.hive.installCatalogTool(r.token);
      else if (r.type === "package") { await window.hive.installCatalogPackage(r.token); rescan(); }
      else { await window.hive.installCatalogAgent(r.token); await syncAgentPlugins(); }
      setReview(null);
      setDone({ entry: e, review: r });
    } catch (err) { setError({ key: catalogKey(e), message: cleanError(err) }); }
    finally { setBusy(null); }
  };
  const cancel = () => setReview(null);
  /** One entry's Install (or Update) button, and what goes under it: the error, or the review with
   *  Cancel and Install. Every place that installs from HiveHub shows these two. */
  const parts = (e: CatalogEntry, { update = false, size = "xs" }: { update?: boolean; size?: "xs" | "default" } = {}) => {
    const key = catalogKey(e);
    const open = review?.key === key ? review.data : null;
    return {
      action: open ? null : <Button size={size} variant={size === "xs" ? "outline" : "default"} disabled={busy === key} onClick={() => void startReview(e)} data-install-start={key}>
        {busy === key ? "Checking…" : update ? "Update" : "Install"}</Button>,
      below: <>
        {error?.key === key && <p role="alert" className="settings-note error">{error.message}</p>}
        {open && <InstallReview entry={e} review={open} busy={busy === key} update={update} reviewRef={reviewRef} onCancel={cancel} onInstall={() => void install(e, open)} />}
      </>,
    };
  };
  return { done, parts };
}

/** What installing it does, in plain words, with Cancel and Install. */
function InstallReview({ entry: e, review: open, busy, update, reviewRef, onCancel, onInstall }: {
  entry: CatalogEntry; review: CatalogReview; busy: boolean; update: boolean;
  reviewRef: RefObject<HTMLElement | null>; onCancel: () => void; onInstall: () => void;
}) {
  return <section ref={reviewRef} tabIndex={-1} className="settings-install-review" aria-label={`Review ${e.name}`} data-install-review={catalogKey(e)}>
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
      <Button variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button disabled={busy} onClick={onInstall} data-install-confirm>{busy ? "Installing…" : update ? "Update" : "Install"}</Button>
    </div>
  </section>;
}
