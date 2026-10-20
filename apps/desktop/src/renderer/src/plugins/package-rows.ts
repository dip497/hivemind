/**
 * The Plugins page's packages: one row per installed package that holds more than one plugin,
 * each member under it with whether it is on and what its own switch may do. Such a member is
 * also a row of its kind's tab, marked as part of its package, with no switch of the package's
 * there. A package of one is only its plugin's row, as before.
 */
import type { PackageOf, PluginState } from "@hivemind/core/plugin-settings";
import type { InstalledPackageInfo } from "../../../shared/ipc";

/** Members with a switch of their own; the rest (an agent preset) go with their package. */
const OWN_SWITCH = ["view", "widget", "tool"] as const;
export type SwitchableKind = (typeof OWN_SWITCH)[number];

export interface PackageRowMember {
  kind: string;
  id: string;
  name: string;
  runs: InstalledPackageInfo["members"][number]["runs"];
  /** It loads: its package is on and it was not switched off on its own. */
  on: boolean;
  /** Its own switch, when it has one. Off is always allowed; on only while its package is on. */
  own: { kind: SwitchableKind; canTurnOn: boolean } | null;
}

export interface PackageRow {
  id: string; name: string; version: string; on: boolean; members: PackageRowMember[];
  /** The version a rollback puts back. */
  previous: string | null;
}

/** The package of several a plugin is part of, or null for one installed on its own. */
export const partOfPackage = (p: { package?: PackageOf }): PackageOf | null => (p.package && p.package.members > 1 ? p.package : null);

/** A member of a package that is off cannot be switched on by itself. */
export const heldOffByPackage = (p: { package?: PackageOf }): boolean => !!partOfPackage(p) && !p.package!.on;

/**
 * The rows, by package name. `nameOf` gives a member's name when the app has read it, else its
 * id is shown. `matches` keeps a package when its name, id or a member's name or id matches.
 */
export function packageRows(packages: readonly InstalledPackageInfo[], states: Record<string, PluginState>,
  nameOf: (kind: string, id: string) => string | undefined, matches: (text: string) => boolean = () => true): PackageRow[] {
  return packages
    .filter((p) => p.members.length > 1)
    .map((p) => ({
      id: p.id, name: p.name, version: p.version, on: p.on, previous: p.previous?.version ?? null,
      members: p.members.map((m) => {
        const own = (OWN_SWITCH as readonly string[]).includes(m.kind) ? { kind: m.kind as SwitchableKind, canTurnOn: p.on } : null;
        return { kind: m.kind, id: m.id, runs: m.runs, name: nameOf(m.kind, m.id) ?? m.id, on: p.on && (!own || states[`${m.kind}:${m.id}`]?.enabled !== false), own };
      }),
    }))
    .filter((p) => matches(`${p.name} ${p.id} ${p.members.map((m) => `${m.name} ${m.id}`).join(" ")}`))
    .sort((a, b) => a.name.localeCompare(b.name));
}
