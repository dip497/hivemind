/**
 * The Add menu's "From HiveHub": while searching, the tools and widgets HiveHub lists that match and
 * are not ready to add here, each with its one step (Install, or Switch on for one installed off).
 * Installing goes through the same review as Settings ▸ Plugins ▸ HiveHub.
 */
import { useEffect, useState } from "react";
import { isPluginOn } from "@hivemind/core/plugin-settings";
import { Button } from "../components/ui/button";
import { ShowMore, useShowMore } from "../components/ui/show-more";
import { useSettings } from "../settings-store";
import { useWidgetPackages } from "../board-objects/widget-runtime";
import { useToolPackages } from "../tiles/tool-plugins";
import { CatalogMark } from "../settings-plugins";
import { InstallReview, catalogKey, useCatalogInstall, useInstalledVersion, type CatalogEntry } from "../plugins/catalog-install";
import type { PluginCategory } from "@hivemind/view-sdk/category";
import { searchPlugins } from "@hivemind/core/plugin-search";

const HUB_FIRST = 5;
const HEADING = "px-2 pb-0.5 pt-2 text-label font-medium text-[var(--color-fg2)]";
const QUIET = "px-2 py-1.5 text-label text-[var(--color-fg2)]";

/** HiveHub's catalog, asked for once per opening of the menu, when the first search is typed. */
function useHubCatalog(wanted: boolean): CatalogEntry[] | "unreachable" | null {
  const [list, setList] = useState<CatalogEntry[] | "unreachable" | null>(null);
  useEffect(() => {
    if (!wanted || list) return;
    let live = true;
    window.hive.pluginCatalog().then((l) => { if (live) setList(l); }, () => { if (live) setList("unreachable"); });
    return () => { live = false; };
  }, [wanted, list]);
  return list;
}

export function FromHiveHub({ query, tab, shelf, installedCount, close }: {
  query: string;
  tab: "all" | "tool" | "widget";
  shelf: PluginCategory | "all";
  /** How many installed choices match: with none, and nothing here, nothing matches anywhere. */
  installedCount: number;
  /** Closes the menu, for Settings to open in its place. */
  close: () => void;
}) {
  const q = query.trim().toLowerCase();
  const catalog = useHubCatalog(!!q);
  const installed = useInstalledVersion();
  const state = useSettings().plugins.state;
  const tools = useToolPackages().packages;
  const widgets = useWidgetPackages();
  const { review, busy, error, done, reviewRef, startReview, install, cancel } = useCatalogInstall();
  const [limit, more] = useShowMore(HUB_FIRST, 10, `${q}\n${tab}\n${shelf}`);
  if (!q) return null;

  const isOn = (e: CatalogEntry): boolean => {
    if (e.type === "tool") { const p = tools.find((t) => t.id === e.id && t.source === "you"); return !!p && isPluginOn(state, "tool", p, false); }
    const w = widgets.find((x) => x.id === e.id);
    return !!w && isPluginOn(state, "widget", w);
  };
  const matches = Array.isArray(catalog) ? searchPlugins(catalog.filter((e) =>
    (e.type === "tool" || e.type === "widget") && (tab === "all" || e.type === tab)
    && (shelf === "all" || (e.category ?? "other") === shelf)
    // Installed and on, it is in the list above, ready to add.
    && !(installed(e) && isOn(e))), q) : [];

  if (catalog === null) return <p className={QUIET} data-add-hub="loading">Searching HiveHub…</p>;
  if (catalog === "unreachable") return <p className={QUIET} data-add-hub="unreachable">HiveHub could not be reached, so only what is installed is shown.</p>;
  if (!matches.length) return <>
    {done && <p role="status" className={QUIET} data-add-hub-done>{done.entry.name} is installed and listed above.</p>}
    {!installedCount && <p className={QUIET} data-add-hub="none">Nothing installed or on HiveHub matches “{query.trim()}”. Make your own below.</p>}
  </>;

  return <div role="group" aria-label="From HiveHub" data-add-hub="results">
    <div className={HEADING}>From HiveHub</div>
    {done && <p role="status" className={QUIET} data-add-hub-done>{done.entry.name} is installed{installed(done.entry) && isOn(done.entry) ? " and listed above" : ""}.</p>}
    {matches.slice(0, limit).map((e) => {
      const key = catalogKey(e);
      const open = review?.key === key ? review.data : null;
      const have = !!installed(e);
      const toPage = () => { close(); window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: `plugin:${e.type}:${e.id}` } })); };
      return <div key={key} data-add-hub-entry={key} data-state={have ? "off" : "not-installed"}>
        <div className="flex items-center gap-2 rounded-md px-2 py-1">
          <span className="grid size-4 shrink-0 place-items-center [&>*]:!size-4"><CatalogMark entry={e} /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-label text-[var(--color-fg)]">{e.name}</span>
            <span className="block truncate text-count text-[var(--color-fg2)]">{have ? "Installed, switched off" : e.description}</span>
          </span>
          {have
            ? <Button size="xs" variant="outline" onClick={toPage} data-add-hub-switch-on title="Its page in Settings has the switch">Switch on…</Button>
            : !open && <Button size="xs" variant="outline" disabled={busy === key} onClick={() => void startReview(e)} data-add-hub-install>
              {busy === key ? "Checking…" : "Install"}</Button>}
        </div>
        {error?.key === key && <p role="alert" className="px-2 pb-1 text-count text-[var(--color-err)]">{error.message}</p>}
        {open && <div className="px-2 pb-2"><InstallReview entry={e} review={open} busy={busy === key} update={false} reviewRef={reviewRef} onCancel={cancel} onInstall={() => void install(e, open)} /></div>}
      </div>;
    })}
    <ShowMore left={matches.length - limit} step={10} onClick={more} />
  </div>;
}
