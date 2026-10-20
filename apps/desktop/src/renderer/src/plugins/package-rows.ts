/**
 * The Plugins page's package rows: one per installed package that holds more than one plugin,
 * each member under it with whether it is on and what its own switch may do. A package of one
 * is its plugin's row in its kind's group, as before.
 */
import type { PluginState } from "@hivemind/core/plugin-settings";
import type { InstalledPackageInfo } from "../../../shared/ipc";

/** Members with a switch of their own; the rest (an agent preset) go with their package. */
const OWN_SWITCH = ["view", "widget", "tool"] as const;
export type SwitchableKind = (typeof OWN_SWITCH)[number];

export interface PackageRowMember {
  kind: string;
  id: string;
  name: string;
  /** It loads: its package is on and it was not switched off on its own. */
  on: boolean;
  /** Its own switch, when it has one. Off is always allowed; on only while its package is on. */
  own: { kind: SwitchableKind; canTurnOn: boolean } | null;
}

export interface PackageRow { id: string; name: string; version: string; on: boolean; members: PackageRowMember[] }

/** Whether a plugin is listed under its package's row rather than its kind's group. */
export const underPackageRow = (p: { package?: { members: number } }): boolean => (p.package?.members ?? 1) > 1;

/**
 * The rows, by package name. `nameOf` gives a member's name when the app has read it, else its
 * id is shown. `matches` keeps a package when its name, id or a member's name or id matches.
 */
export function packageRows(packages: readonly InstalledPackageInfo[], states: Record<string, PluginState>,
  nameOf: (kind: string, id: string) => string | undefined, matches: (text: string) => boolean = () => true): PackageRow[] {
  return packages
    .filter((p) => p.members.length > 1)
    .map((p) => ({
      id: p.id, name: p.name, version: p.version, on: p.on,
      members: p.members.map((m) => {
        const own = (OWN_SWITCH as readonly string[]).includes(m.kind) ? { kind: m.kind as SwitchableKind, canTurnOn: p.on } : null;
        return { kind: m.kind, id: m.id, name: nameOf(m.kind, m.id) ?? m.id, on: p.on && (!own || states[`${m.kind}:${m.id}`]?.enabled !== false), own };
      }),
    }))
    .filter((p) => matches(`${p.name} ${p.id} ${p.members.map((m) => `${m.name} ${m.id}`).join(" ")}`))
    .sort((a, b) => a.name.localeCompare(b.name));
}
