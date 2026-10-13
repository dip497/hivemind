/**
 * How the Plugins page draws a plugin, of any kind, installed or on HiveHub: one group per kind
 * with its count, and one row per plugin with the same parts. What a row's plugin can be set to
 * is on its own page; the row says only its state.
 */
import type { ReactNode } from "react";
import { ChevronRight } from "../components/icons";
import { Badge } from "../components/ui/badge";
import { MenuItem } from "../components/ui/menu-item";
import { useSettingsNavigate } from "../settings-panels";
import { KIND_LABEL, type PluginKind } from "./library";

export type RowState = "on" | "off" | "missing" | "unavailable";

export function PluginRow({ kind, id, name, line, mark, state = "on", badge, action }: {
  kind: PluginKind;
  id: string;
  name: string;
  /** What it does, or what stops it, in plain words. */
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
          <span className="plugin-row-detail">{line}</span>
        </span>
      </MenuItem>
      {action ?? (badge && <Badge variant="secondary" data-plugin-badge>{badge}</Badge>)}
      <ChevronRight className="plugin-row-go" size={15} />
    </div>
  );
}

export function PluginGroup({ kind, count, foot, children }: { kind: PluginKind; count: number; foot?: ReactNode; children: ReactNode }) {
  const title = `${KIND_LABEL[kind]}s`;
  return (
    <section className="plugins-group" aria-label={title} data-plugins-kind={kind}>
      <h3 className="plugins-group-heading">{title}<span>{count}</span></h3>
      {count > 0 && <div className="plugin-rows">{children}</div>}
      {foot && <div className="plugins-group-foot">{foot}</div>}
    </section>
  );
}
