/** The kinds of plugin you write and install, each as data: what makes a folder one, its id, its
 *  starter, how it is copied in and taken out, and the steps to see it. `hive plugins new|install|
 *  remove` is one path over this table. */
import { installView, removeView } from "@hivemind/core";
import { installToolPackage, removeToolPackage, TOOL_MANIFEST } from "@hivemind/core/tool-packages";
import { installWidget, removeWidget } from "@hivemind/core/widgets";
import { MANIFEST_FILE as VIEW_MANIFEST } from "@hivemind/view-sdk/manifest";
import { toolStarter, widgetStarter } from "./starters.js";
import { starterFiles as viewStarter } from "./view-starter.js";

export interface Installed { id: string; name: string; dir: string }

export interface AuthoredKind {
  /** As a plugin record names it: `<kind>:<id>`. */
  kind: "tool" | "widget" | "view";
  /** What it is called in a sentence. */
  noun: string;
  /** The file that makes a folder one of these. */
  manifest: string;
  idOf(owner: string, name: string): string;
  starter(owner: string, name: string): Record<string, string>;
  /** Copies a checked folder in; `hubId` is the id HiveHub listed it under. */
  install(dir: string, hubId?: string): Promise<Installed>;
  remove(id: string): Promise<void>;
  /** What a running app is asked, in order, to load them again. */
  rescan: string[];
  /** On once installed, or off until you switch it on. */
  onByDefault: boolean;
  /** From a new starter at `dir` to installed. */
  build(dir: string): string[];
  /** From on to seeing it in the app. */
  see(id: string): string[];
  guide: string;
}

const GUIDE = "https://hivemind.griiken.com/guide";

export const KINDS: readonly AuthoredKind[] = [
  {
    kind: "tool", noun: "tool plugin", manifest: TOOL_MANIFEST,
    idOf: (owner, name) => `${owner}/${name}`,
    starter: toolStarter,
    install: (dir, hubId) => installToolPackage(dir, hubId),
    remove: removeToolPackage,
    rescan: ["settings.reload", "tools.rescan"],
    onByDefault: false,
    build: (dir) => [`hive plugins install ${dir}`],
    see: (id) => [`hive ctl plugin open tool:${id}`, "hive ctl tile look <tile>    # what it drew, and what its code logged"],
    guide: `${GUIDE}/tool-plugins/`,
  },
  {
    kind: "widget", noun: "widget", manifest: "widget.json",
    idOf: (owner, name) => `@${owner}/${name}`,
    starter: widgetStarter,
    install: async (dir, hubId) => { const w = await installWidget(dir, hubId); return { id: w.id, name: w.name, dir: w.dir ?? dir }; },
    remove: removeWidget,
    rescan: ["widgets.rescan"],
    onByDefault: true,
    build: (dir) => [`hive plugins install ${dir}`],
    see: (id) => [`hive ctl plugin open widget:${id}`],
    guide: `${GUIDE}/widgets/`,
  },
  {
    kind: "view", noun: "view", manifest: VIEW_MANIFEST,
    idOf: (owner, name) => `@${owner}/${name}`,
    starter: viewStarter,
    install: async (dir) => { const v = await installView(dir); return { id: v.id, name: v.manifest?.name ?? v.id, dir: v.dir }; },
    remove: removeView,
    rescan: ["views.rescan"],
    onByDefault: true,
    build: (dir) => [`cd ${dir} && npm install && npm run dev    # builds dist/ and installs it`],
    see: (id) => [`hive ctl plugin open view:${id}`],
    guide: `${GUIDE}/extension-authoring/`,
  },
];

export const kindNamed = (kind: string): AuthoredKind | undefined => KINDS.find((k) => k.kind === kind);
