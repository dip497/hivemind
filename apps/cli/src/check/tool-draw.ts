/** A tool plugin loaded and each of its tiles drawn once, as the app would: its imports of
 *  `hm-plugin://host/*.js` answered with React itself and the SDK's parts, `hm` a view-SDK fake
 *  host's client, `host` a folder whose programs all succeed with no output. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToString } from "react-dom/server";
import { TILE_API_VERSION, toolModuleProblem, type HostSdk, type TileHost, type TileProps } from "@hivemind/tile-sdk";
import { fakeHost } from "@hivemind/view-sdk/testing";
import { resolveSettings } from "@hivemind/core/plugin-settings";
import type { ToolPackage } from "@hivemind/core/tool-format";
import { thrown, type Problem } from "./problem.js";

const h = React.createElement;
type Props = Record<string, unknown> & { children?: React.ReactNode; className?: string };

/** The parts `sdk.js` gives, drawn plainly: what they take and that they draw, not how they look. */
const sdk: HostSdk = {
  TILE_API_VERSION,
  Button: ({ children, onClick: _, ...p }: Props) => h("button", { className: p.className as string | undefined }, children),
  PatchView: ({ patch, className }: { patch: string; className?: string }) => h("pre", { className }, patch),
  Markdown: ({ text, className }: { text: string; className?: string }) => h("div", { className }, text),
  Loading: ({ label, className }: { label?: string; className?: string }) => h("div", { className }, label ?? "Loading"),
  Frame: ({ src, title, className }: { src: string; title?: string; className?: string }) =>
    h("iframe", { src, title: title ?? src, className, sandbox: "allow-scripts allow-same-origin allow-forms allow-popups" }),
  useTileState: <T,>(hm: unknown, key: string, initial: T): [T, (v: T) => void] => {
    const saved = ((hm as { hello?: { layout?: unknown } }).hello?.layout ?? {}) as Record<string, unknown>;
    const [v, set] = React.useState<T>(Object.hasOwn(saved, key) ? saved[key] as T : initial);
    return [v, set];
  },
} as HostSdk;

/** `ui.js` is the app's own kit, which needs its window: each name a plugin imports from it draws
 *  as a plain box of its children. */
function uiStandIns(code: string): Record<string, unknown> {
  const names = new Set<string>();
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']hm-plugin:\/\/host\/ui\.js["']/g)) {
    for (const part of m[1]!.split(",")) { const n = part.trim().split(/\s+as\s+/)[0]; if (n) names.add(n); }
  }
  const box = ({ children }: Props) => h("div", null, children);
  return Object.fromEntries([...names].map((n) => [n, n === "toast" ? Object.assign(() => {}, { success() {}, error() {}, info() {} }) : box]));
}

let registered = false;
function hostModules(entryCode: string): void {
  if (registered) return;
  registered = true;
  const mods: Record<string, Record<string, unknown>> = {
    react: { ...React, default: React }, "react-jsx-runtime": { ...jsxRuntime }, sdk: { ...sdk }, ui: uiStandIns(entryCode),
  };
  Bun.plugin({
    name: "hivemind-host-modules",
    setup(build) {
      for (const [name, exports] of Object.entries(mods)) build.module(`hm-plugin://host/${name}.js`, () => ({ exports, loader: "object" }));
    },
  });
}

/** The plugin's own scripts, together, for the names they import. */
function codeIn(dir: string): string {
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.m?js$/.test(f) && !f.split(path.sep).includes("node_modules"));
  return files.slice(0, 500).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
}

/** Where `name` is first written in `dir/file`, for an import the host does not give. */
function lineOf(dir: string, file: string, name: string): { file: string; line?: number } {
  const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
  const i = lines.findIndex((l) => new RegExp(`\\b${name}\\b`).test(l));
  return i < 0 ? { file } : { file, line: i + 1 };
}

export async function drawTool(pkg: ToolPackage): Promise<Problem[]> {
  const dir = pkg.dir;
  const entry = path.join(dir, pkg.entry);
  hostModules(codeIn(dir));
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (e) {
    const missing = /Export named '([^']+)' not found in module '([^']+)'/.exec(e instanceof Error ? e.message : "");
    if (missing) return [{ step: "draw", ...lineOf(dir, pkg.entry, missing[1]!), message: `${missing[2]} has no ${missing[1]}` }];
    return [thrown("draw", e, dir, "loading it failed: ")];
  }
  const kinds = Object.keys(pkg.tiles);
  const why = toolModuleProblem(mod, kinds);
  if (why) return [{ step: "draw", file: pkg.entry, message: why }];
  const tiles = (mod as { default: { tiles: Record<string, (p: TileProps) => unknown> } }).default.tiles;
  const host: TileHost = {
    repoPath: dir, cwd: dir,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    openFile: () => {}, openUrl: () => {},
  };
  const problems: Problem[] = [];
  for (const kind of kinds) {
    const fake = fakeHost({ pluginId: pkg.id, capabilities: pkg.permissions, settings: resolveSettings(pkg.settings, {}) as never });
    try {
      const hm = await fake.connect();
      renderToString(h(tiles[kind] as React.FC<TileProps>, { tile: { id: "check", kind, name: pkg.name, frameId: null }, hm, host, selected: false }));
    } catch (e) {
      problems.push(thrown("draw", e, dir, `drawing its tile "${kind}" threw: `));
    } finally { fake.close(); }
  }
  return problems;
}
