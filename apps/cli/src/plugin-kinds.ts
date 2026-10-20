/** The kinds of plugin you write, each as data: what makes a folder one, its id, its starter, how
 *  it is checked, and the steps to see it. `hive plugins new|check` is one path over this table;
 *  installing and removing are the package store's (`@hivemind/core/package-install`), the same
 *  for every kind. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readToolPackage, TOOL_MANIFEST } from "@hivemind/core/tool-packages";
import { readWidget } from "@hivemind/core/widgets";
import { MANIFEST_FILE as VIEW_MANIFEST, validateViewManifest } from "@hivemind/view-sdk/manifest";
import type { Problem } from "./check/problem.js";
import { TOOL_TYPE_SETUP, toolStarter, WIDGET_TYPE_SETUP, widgetStarter } from "./starters.js";
import { starterFiles as viewStarter, VIEW_TYPE_SETUP } from "./view-starter.js";
import type { TypeSetup } from "./check/types.js";
import { WIDGET_TYPES } from "@hivemind/core/widget-api";
import { declaration, typeSources } from "./type-files.js";

export interface AuthoredKind {
  /** As a plugin record names it: `<kind>:<id>`. */
  kind: "tool" | "widget" | "view";
  /** What it is called in a sentence. */
  noun: string;
  /** The file that makes a folder one of these. */
  manifest: string;
  idOf(owner: string, name: string): string;
  starter(owner: string, name: string): Record<string, string>;
  /** What a running app is asked, in order, to load them again. */
  rescan: string[];
  /** On once installed, or off until you switch it on. */
  onByDefault: boolean;
  /** What a new starter at `dir` needs before it can be checked. */
  prepare(dir: string): string[];
  /** From checked to installed. */
  add(dir: string): string[];
  /** From on to seeing it in the app. */
  see(id: string): string[];
  guide: string;
  /** What its code is given, as the declarations of the types its starter ships. */
  api(): string;
  /** What its code is checked against, by its editor and by `hive plugins check`. */
  types: TypeSetup;
  /** Why the manifest in `dir` is not one this kind loads; empty when it is. */
  validate(dir: string): Promise<string[]>;
  /** Its code loaded and drawn once, as the app would: what went wrong. */
  draw(dir: string): Promise<Problem[]>;
}

const why = (e: unknown) => [e instanceof Error ? e.message : String(e)];

/** The named declarations, each from its `<package>/<file>`, one after another. */
const declarations = (wanted: Array<[string, string[]]>): string => {
  const src = typeSources();
  return wanted.flatMap(([file, names]) => names.map((n) => declaration(src[file] ?? "", n) ?? `// ${n}: not in ${file}`)).join("\n\n") + "\n";
};

const GUIDE = "https://hivemind.griiken.com/guide";

export const KINDS: readonly AuthoredKind[] = [
  {
    kind: "tool", noun: "tool plugin", manifest: TOOL_MANIFEST,
    idOf: (owner, name) => `@${owner}/${name}`,
    starter: toolStarter,
    rescan: ["settings.reload", "tools.rescan"],
    onByDefault: false,
    prepare: () => [],
    add: (dir) => [`hive plugins install ${dir}`],
    see: (id) => [`hive ctl plugin open tool:${id}`, "hive ctl tile look <tile>    # what it drew, and what its code logged"],
    guide: `${GUIDE}/tool-plugins/`,
    api: () => declarations([["tile-sdk/index.ts", ["TileProps", "TileInfo", "TileHost", "RunResult", "HostSdk", "ToolModule"]], ["view-sdk/client.ts", ["ViewClient"]]]),
    types: TOOL_TYPE_SETUP,
    validate: (dir) => readToolPackage(dir, null).then((p) => (p.problem ? [p.problem] : []), why),
    draw: async (dir) => (await import("./check/tool-draw.js")).drawTool(await readToolPackage(dir, null)),
  },
  {
    kind: "widget", noun: "widget", manifest: "widget.json",
    idOf: (owner, name) => `@${owner}/${name}`,
    starter: widgetStarter,
    rescan: ["widgets.rescan"],
    onByDefault: true,
    prepare: () => [],
    add: (dir) => [`hive plugins install ${dir}`],
    see: (id) => [`hive ctl plugin open widget:${id}`],
    guide: `${GUIDE}/widgets/`,
    api: () => WIDGET_TYPES,
    types: WIDGET_TYPE_SETUP,
    validate: (dir) => readWidget(dir).then(() => [], why),
    draw: async (dir) => (await import("./check/widget-draw.js")).drawWidget(await readWidget(dir), dir),
  },
  {
    kind: "view", noun: "view", manifest: VIEW_MANIFEST,
    idOf: (owner, name) => `@${owner}/${name}`,
    starter: viewStarter,
    rescan: ["views.rescan"],
    onByDefault: true,
    prepare: (dir) => [`cd ${dir} && npm install`],
    add: (dir) => [`cd ${dir} && npm run dev    # builds dist/ and installs it`],
    see: (id) => [`hive ctl plugin open view:${id}`],
    guide: `${GUIDE}/extension-authoring/`,
    api: () => declarations([["view-sdk/client.ts", ["ConnectOptions", "ViewClient"]]]),
    types: VIEW_TYPE_SETUP,
    validate: async (dir) => {
      try {
        const m = validateViewManifest(JSON.parse(await readFile(path.join(dir, VIEW_MANIFEST), "utf8")));
        return m.ok ? [] : m.errors;
      } catch (e) { return why(e); }
    },
    draw: async (dir) => (await import("./check/view-draw.js")).drawView(dir),
  },
];

export const kindNamed = (kind: string): AuthoredKind | undefined => KINDS.find((k) => k.kind === kind);
