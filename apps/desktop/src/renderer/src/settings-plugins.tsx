import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { setViewMode } from "./workspace/view-mode-store";
import { Blocks, ChevronDown, ChevronRight, LayoutGrid } from "./components/icons";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { iconFromManifest } from "@hivemind/agents";
import { Button } from "./components/ui/button";
import { Loading } from "./components/ui/loading";
import { SvgMark } from "./agents";
import { MaskIcon, catalogImage } from "./plugins/mask-icon";
import { rescan } from "./settings-views";
import { searchPlugins } from "@hivemind/core/plugin-search";
import { rowsInKindTab, TAB_LABEL, type PluginTab } from "./plugins/kinds";
import { MemberIcon, MEMBER_KIND, RUNS_LABEL, askedFor } from "./plugins/PackageReview";
import { InstallReview, catalogKey, cleanError, useCatalogInstall, useInstalledVersion, type CatalogEntry } from "./plugins/catalog-install";
import { memberFormat } from "@hivemind/hub";
import { CategoryGroups, KindTabs, PluginRow, type ListedRow } from "./plugins/PluginList";
import { useSettingsNavigate } from "./settings-panels";

type Entry = CatalogEntry;

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
  const image = catalogImage(entry.icon);
  const icon = useMemo(() => {
    try { return entry.icon && !catalogImage(entry.icon) ? iconFromManifest(entry.icon as Parameters<typeof iconFromManifest>[0]) : null; }
    catch { return null; } // a mark we cannot read is a mark we do not draw
  }, [entry.icon]);
  if (image) return <MaskIcon url={image} size={20} />;
  if (icon) return <SvgMark icon={icon} size={20} />;
  let hue = 0;
  for (const c of entry.id) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return <span className="catalog-monogram" style={{ "--mark-hue": hue } as CSSProperties}>{entry.id[0]?.toUpperCase()}</span>;
}

/** Rows a HiveHub category shows before its "Show more", so a catalog of thousands draws a few dozen. */
const CATALOG_FIRST = 25;

/** What HiveHub lists, found by the Plugins page's search, the open tab's kind under its
 *  categories; each one installed after its review, here or on its own page. */
export function BrowsePlugins({ query, tab, onTab }: { query: string; tab: PluginTab; onTab: (tab: PluginTab) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outdated, setOutdated] = useState<string[]>([]);
  const [holding, setHolding] = useState<string | null>(null);
  const { review, busy, error, done, reviewRef, startReview, install, cancel } = useCatalogInstall();
  const installed = useInstalledVersion();
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

  const q = query.trim().toLowerCase();
  const shown = searchPlugins(entries ?? [], query);
  const key = catalogKey;
  // A view says which version it is; an agent does not, so what it has is compared by content
  // instead — the same hash the catalog pins it by.
  const outdatedOf = (e: Entry): boolean => {
    const have = installed(e);
    return e.type === "agent" ? outdated.includes(e.id) : !!have && newer(e.version, have);
  };

  const { counts, groups } = rowsInKindTab(shown.map((e): ListedRow => {
    const have = installed(e);
    const update = outdatedOf(e);
    const open = review?.key === key(e) ? review.data : null;
    const action = (!have || update) && !open ? <Button size="xs" variant="outline" disabled={busy === key(e)} onClick={() => void startReview(e)}>
      {busy === key(e) ? "Checking…" : update ? "Update" : "Install"}</Button> : undefined;
    return { key: key(e), kind: e.type, category: e.category ?? "other", row: <div className="catalog-item" data-catalog-plugin={key(e)}>
      {e.type === "package"
        ? <CatalogPackageRow entry={e} installed={!!have && !update} action={action} open={holding === e.id} toggle={() => setHolding(holding === e.id ? null : e.id)} />
        : <PluginRow kind={e.type} id={e.id} name={e.name} line={e.description} mark={e.type === "agent" || catalogImage(e.icon) ? <CatalogMark entry={e} /> : <LayoutGrid size={16} />}
          badge={have && !update ? "Installed" : undefined} action={action} />}
      {error?.key === key(e) && <p role="alert" className="settings-note error">{error.message}</p>}
      {open && <InstallReview entry={e} review={open} busy={busy === key(e)} update={outdatedOf(e)} reviewRef={reviewRef} onCancel={cancel} onInstall={() => void install(e, open)} />}
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
    <CategoryGroups key={`${tab}:${q}`} groups={groups} first={CATALOG_FIRST} />
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
