/**
 * Every plugin this app knows, of every kind, as one list: what Settings shows, filters and opens
 * one page for. Agents, views, widgets and tools each keep their own loader; this is where they
 * meet, with the catalog's for the ones not installed. One record per plugin, so every row, every
 * page and every check reads the same fields the same way.
 */
import { useEffect, useMemo, useState } from "react";
import { agentDisclosures, defFromManifest } from "@hivemind/agents";
import { BUNDLED_TOOL_PLUGINS } from "@hivemind/core/tool-plugins";
import type { CatalogEntry } from "@hivemind/core/plugin-catalog";
import { useAgentEntries } from "../agent-plugins";
import { useCommunityReport } from "../workspace/views/community/registry";
import { useViews } from "../workspace/workspace-view";
import { useWidgetPackages } from "../board-objects/widget-runtime";
import { useToolPackages } from "../tiles/tool-plugins";
import { isPluginEnabled } from "@hivemind/core/plugin-settings";
import { useSettings } from "../settings-store";

import type { PluginKind } from "./kinds";
export { KIND_LABEL, type PluginKind } from "./kinds";

/** Where a plugin came from: with the app, added by you, from the repository you have open, or
 *  from HiveHub (installed from it, or only listed there). */
export type PluginOrigin = "app" | "you" | "repo" | "hub";
export const ORIGIN_LABEL: Record<PluginOrigin, string> = { app: "Comes with the app", you: "You added this", repo: "From this repository", hub: "From HiveHub" };

export interface PluginRecord {
  kind: PluginKind;
  id: string;
  name: string;
  description: string;
  author?: string;
  version?: string;
  origin: PluginOrigin;
  installed: boolean;
  /** On or off; undefined when it cannot be switched off. */
  enabled?: boolean;
  /** What it may do beyond showing itself, in plain words. */
  can: string[];
  /** Where its README is read from, or its text; null when it has none. */
  readme: { dir: string } | { catalog: { type: CatalogEntry["type"]; id: string } } | { text: string } | null;
  /** Its catalog listing, when HiveHub lists it. */
  catalog?: CatalogEntry;
  /** Why it does not load, when it does not. */
  problem?: string | null;
  /** Its installed folder, when it has one. */
  dir?: string;
}

/** The key a plugin's page is opened by: `plugin:<kind>:<id>`. */
export const pluginKey = (p: Pick<PluginRecord, "kind" | "id">): string => `plugin:${p.kind}:${p.id}`;

export { permissionWords } from "@hivemind/view-sdk/protocol";
import { permissionWords } from "@hivemind/view-sdk/protocol";

const dirOf = (file: string): string => file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));

/** The catalog, once per Settings visit: what a plugin page and the lists compare against. */
let catalog: Promise<CatalogEntry[]> | null = null;
export function useCatalog(): CatalogEntry[] | null {
  const [list, setList] = useState<CatalogEntry[] | null>(null);
  useEffect(() => {
    // One that could not be fetched is asked for again by the next screen that shows it.
    catalog ??= window.hive.pluginCatalog().catch(() => { catalog = null; return []; });
    let live = true;
    void catalog.then((l) => { if (live) setList(l); });
    return () => { live = false; };
  }, []);
  return list;
}

/** What HiveHub says a plugin does, for one installed without a description of its own. */
export function useHubDescription(): (kind: PluginKind, id: string) => string {
  const list = useCatalog();
  return useMemo(() => {
    const by = new Map((list ?? []).map((e) => [`${e.type}:${e.id}`, e.description]));
    return (kind, id) => by.get(`${kind}:${id}`) ?? "";
  }, [list]);
}

/** Every plugin: installed ones of each kind, then the catalog's not installed. */
export function usePlugins(catalog: CatalogEntry[] | null): PluginRecord[] {
  const agents = useAgentEntries();
  const report = useCommunityReport();
  const views = useViews();
  const widgets = useWidgetPackages();
  const tools = useToolPackages().packages;
  const { plugins: { state }, agents: { fromCatalog } } = useSettings();
  return useMemo(() => {
    const listed = new Map((catalog ?? []).map((e) => [`${e.type}:${e.id}`, e]));
    const out: PluginRecord[] = [];
    for (const e of agents) {
      let def;
      try { def = e.error ? undefined : defFromManifest(e.manifest); } catch { def = undefined; }
      const m = (e.manifest ?? {}) as { description?: unknown; version?: unknown; author?: unknown };
      out.push({
        kind: "agent", id: e.id, name: def?.label ?? e.id,
        description: typeof m.description === "string" ? m.description : listed.get(`agent:${e.id}`)?.description ?? "",
        ...(typeof m.version === "string" ? { version: m.version } : {}), ...(typeof m.author === "string" ? { author: m.author } : {}),
        origin: e.source === "repo" ? "repo" : fromCatalog.includes(e.id) ? "hub" : "you", installed: true, enabled: !e.disabled,
        can: def ? agentDisclosures(def) : [], readme: { dir: dirOf(e.file) }, problem: e.error,
        dir: dirOf(e.file), ...(listed.get(`agent:${e.id}`) ? { catalog: listed.get(`agent:${e.id}`)! } : {}),
      });
    }
    for (const v of views.filter((x) => x.source !== "community")) {
      out.push({ kind: "view", id: v.id, name: v.label, description: v.hint, origin: "app", installed: true, can: [], readme: null });
    }
    for (const p of report.packages) {
      const m = p.manifest;
      out.push({
        kind: "view", id: p.id, name: m?.name ?? p.id, description: m?.description ?? listed.get(`view:${p.id}`)?.description ?? "",
        ...(m?.version ? { version: m.version } : {}), ...(m?.author ? { author: m.author } : {}),
        origin: p.source === "user" ? "you" : p.source === "app" ? "app" : "repo", installed: true, can: permissionWords(m?.permissions ?? []),
        readme: { dir: p.dir }, problem: p.error ?? (report.refused[p.id] !== "disabled in Settings" ? report.refused[p.id] : null) ?? null, dir: p.dir,
        ...(listed.get(`view:${p.id}`) ? { catalog: listed.get(`view:${p.id}`)! } : {}),
      });
    }
    for (const w of widgets) {
      out.push({
        kind: "widget", id: w.id, name: w.name, description: w.description || (listed.get(`widget:${w.id}`)?.description ?? ""), origin: w.builtin ? "app" : "you", installed: true,
        ...(w.version ? { version: w.version } : {}), ...(listed.get(`widget:${w.id}`) ? { catalog: listed.get(`widget:${w.id}`)! } : {}),
        can: permissionWords(w.permissions), readme: w.readme !== undefined ? { text: w.readme } : w.builtin ? null : { dir: w.dir ?? "" },
        ...(w.dir ? { dir: w.dir } : {}),
      });
    }
    for (const t of BUNDLED_TOOL_PLUGINS) {
      out.push({
        kind: "tool", id: t.id, name: t.tools.map((x) => x.label).join(", "), description: t.tools.map((x) => x.description).join(" "),
        origin: "app", installed: true, can: [], readme: null,
      });
    }
    // The app's own are listed with the tools that ship, above; these are the ones you added.
    for (const t of tools.filter((x) => x.source === "you")) {
      out.push({
        kind: "tool", id: t.id, name: t.name, description: t.description, origin: "you", installed: true,
        enabled: isPluginEnabled(state, "tool", t.id, false), ...(t.version ? { version: t.version } : {}),
        can: [
          "Runs inside the app, with the access it has: your files, your programs and your logins.",
          ...(t.service ? [`Keeps ${t.service.command.join(" ")} running while it is on, which drives the workspaces you pick for it.`] : []),
          ...permissionWords(t.permissions),
        ],
        readme: { dir: t.dir }, problem: t.problem, dir: t.dir,
        ...(listed.get(`tool:${t.id}`) ? { catalog: listed.get(`tool:${t.id}`)! } : {}),
      });
    }
    const have = new Set(out.map((p) => `${p.kind}:${p.id}`));
    for (const e of catalog ?? []) {
      if (have.has(`${e.type}:${e.id}`)) continue;
      out.push({
        kind: e.type as PluginKind, id: e.id, name: e.name, description: e.description, author: e.author, version: e.version,
        origin: "hub", installed: false, can: [], readme: { catalog: { type: e.type, id: e.id } }, catalog: e,
      });
    }
    return out;
  }, [agents, report, views, widgets, tools, state, fromCatalog, catalog]);
}
