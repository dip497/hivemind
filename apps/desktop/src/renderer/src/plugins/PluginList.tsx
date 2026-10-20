/**
 * How the Plugins page draws a plugin, of any kind, installed or on HiveHub: one group per category,
 * as the Add menu groups them, with its count, and one row per plugin with the same parts. What a row's plugin can be set to
 * is on its own page; the row says only its state.
 */
import { Fragment, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight } from "../components/icons";
import { Badge } from "../components/ui/badge";
import { MenuItem } from "../components/ui/menu-item";
import { useSettingsNavigate } from "../settings-panels";
import { CATEGORY_LABELS, PLUGIN_CATEGORIES, type PluginCategory } from "@hivemind/view-sdk/category";
import { PLUGIN_TABS, TAB_LABEL, type PluginKind, type PluginTab } from "./kinds";

export type RowState = "on" | "off" | "missing" | "unavailable";

export function PluginRow({ kind, id, name, line, mark, state = "on", badge, action }: {
  kind: PluginKind;
  id: string;
  name: string;
  /** What it does, or what stops it, in plain words; empty when nothing says, and not shown when
   *  it only repeats the name. */
  line: string;
  mark: ReactNode;
  state?: RowState;
  badge?: string;
  /** In place of the badge, where the row's one step is taken from the list (Install). */
  action?: ReactNode;
}) {
  const go = useSettingsNavigate();
  return (
    <div className="plugin-row" data-plugin-row={`${kind}:${id}`} data-state={state}>
      <MenuItem className="flex-1 min-w-0" data-plugin-open={`${kind}:${id}`} onClick={() => go(`plugin:${kind}:${id}`)}>
        <span className="plugin-row-mark" aria-hidden="true">{mark}</span>
        <span className="plugin-row-text">
          <span className="plugin-row-name">{name}</span>
          {line && line !== name && <span className="plugin-row-detail">{line}</span>}
        </span>
      </MenuItem>
      {action ?? (badge && <Badge variant="secondary" data-plugin-badge>{badge}</Badge>)}
      <ChevronRight className="plugin-row-go" size={15} />
    </div>
  );
}

/** One row of the list, with the category it is listed under. */
export interface ListedRow { key: string; kind: PluginTab; category: PluginCategory; row: ReactNode }

function PluginGroup({ category, count, foot, children }: { category: PluginCategory; count: number; foot?: ReactNode; children: ReactNode }) {
  const title = CATEGORY_LABELS[category];
  return (
    <section className="plugins-group" aria-label={title} data-plugins-category={category}>
      <h3 className="plugins-group-heading">{title}<span>{count}</span></h3>
      {count > 0 && <div className="plugin-rows">{children}</div>}
      {foot && <div className="plugins-group-foot">{foot}</div>}
    </section>
  );
}

/** One tab per kind, then Packages, each with how many rows it has. */
export function KindTabs({ counts, tab, onChange }: { counts: Record<PluginTab, number>; tab: PluginTab; onChange: (tab: PluginTab) => void }) {
  const step = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!by) return;
    const next = PLUGIN_TABS[(PLUGIN_TABS.indexOf(tab) + by + PLUGIN_TABS.length) % PLUGIN_TABS.length]!;
    onChange(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-plugins-kind="${next}"]`)?.focus();
  };
  return <div role="tablist" aria-label="Kind" className="plugins-scope self-start" onKeyDown={step} data-plugins-kinds>
    {PLUGIN_TABS.map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} tabIndex={tab === k ? 0 : -1}
      data-plugins-kind={k} onClick={() => onChange(k)}>{TAB_LABEL[k]} <span className="plugins-kind-count">{counts[k]}</span></button>)}
  </div>;
}

/** Rows under their category's heading, in the Add menu's order. A category with a foot is shown
 *  even with no rows, so what it does by itself stays reachable. Rows with no category (packages)
 *  are one list without a heading. */
export function CategoryGroups({ groups: listed, feet = {} }: { groups: [PluginCategory | null, ListedRow[]][]; feet?: Partial<Record<PluginCategory, ReactNode>> }) {
  const plain = listed.find(([c]) => c === null)?.[1];
  if (plain) return <section className="plugins-group" aria-label="Packages" data-plugins-category="package">
    <div className="plugin-rows">{plain.map((r) => <Fragment key={r.key}>{r.row}</Fragment>)}</div>
  </section>;
  const groups = new Map(listed as [PluginCategory, ListedRow[]][]);
  return <>
    {PLUGIN_CATEGORIES.filter((c) => groups.has(c) || feet[c]).map((c) => {
      const list = groups.get(c) ?? [];
      return <PluginGroup key={c} category={c} count={list.length} foot={feet[c]}>
        {list.map((r) => <Fragment key={r.key}>{r.row}</Fragment>)}
      </PluginGroup>;
    })}
  </>;
}
