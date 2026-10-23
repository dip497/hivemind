/**
 * The widget package format: what a widget is (its `widget.json` read and checked, its code, its
 * images), and the widgets that ship in the app, written as anyone's would be: data and a drawing,
 * no code. One installed under the same id replaces a built-in. Pure, so the window has them from
 * its first frame; reading folders is `./widgets.ts`.
 */
import { resolveSettings, type SettingField } from "@hivemind/view-sdk/settings";
import type { ViewWidget } from "@hivemind/view-sdk/protocol";
import type { PluginCategory } from "@hivemind/view-sdk/category";
import type { PluginCommand } from "@hivemind/view-sdk/commands";

/** A widget's id: a bare name (a built-in, or one added from a folder), or `@owner/name` for one
 *  published on HiveHub, the owner being the account that published it. */
const WIDGET_ID_RE = /^(?:@(?!.*--)[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}|[a-zA-Z0-9_-]{1,60})$/;
import type { PackageOf } from "./plugin-settings.js";
export const isWidgetId = (id: string): boolean => WIDGET_ID_RE.test(id);

/** The folder a widget lives in under the widgets folder: `@owner/name` as `owner--name`, which no
 *  published name can be, since a scope and a name never hold "--". */
export const widgetFolder = (id: string): string => (id.startsWith("@") ? id.slice(1).replace("/", "--") : id);

/** One thing a widget asks the person for, in the vocabulary every plugin declares its settings in. */
export type WidgetOption = SettingField;

/** A widget package: its folder name, what it is called, the options it asks for, its card's look
 *  ("none": no card, for a pet), what it may do in the workspace (a view's permission names), its images (by file name, as data URLs) and its code. */
export interface WidgetPackage {
  id: string; name: string; options: WidgetOption[]; chrome: "card" | "none"; permissions: string[]; assets: Record<string, string>;
  /** What it is for; the Add menu groups widgets by it. */
  category: PluginCategory;
  /** What an agent may ask it to do while it runs (`hive.hm.onCommand`). */
  commands: PluginCommand[];
  /** Where it goes when added: on the board (moving with it), or floating over every view; and its first size on the board. */
  placement: "board" | "screen"; size: { w: number; h: number };
  /** Its code; "" for a widget drawn from `draw` alone. */
  code: string;
  /** What a widget without code draws, from its content and options. */
  draw?: unknown;
  /** It ships in the app: it can be replaced by one of the same id, not removed. */
  builtin?: boolean;
  /** One line on what it is. */
  description?: string;
  /** Its version, as its widget.json says (`1.2.0`): what an update from HiveHub is compared by. */
  version?: string;
  /** Its mark in menus and lists, as a data URL: an image from its folder (`"icon": "dog.png"` in its
   *  widget.json). A one-colour SVG is drawn in the theme's text colour, like the app's own icons. */
  icon?: string;
  /** Its README: the text, for one that comes with the app. */
  readme?: string;
  /** Its folder, for one installed. */
  dir?: string;
  /** The package it was installed with. */
  package?: PackageOf;
}

/** A mark drawn the way an installed widget's SVG icon is: lines on a 24 px grid, in one colour. */
const mark = (paths: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`)}`;

/** The note colours, as the app's theme names them. */
const NOTE_COLORS = ["yellow", "peach", "pink", "violet", "blue", "green"];

/** The widgets that ship in the app, written as anyone's would be: data and a drawing, no code.
 *  One installed under the same id replaces it. */
export const BUILTIN_WIDGETS: WidgetPackage[] = [
  {
    id: "note", name: "Sticky note", builtin: true, category: "productivity", commands: [], description: "A coloured note on the board that anyone in the workspace can write in.",
    readme: "# Sticky note\n\nA note on the board. Double-click it to write; two people can write in one at once and both keep their words. Pick its colour from the dots above it when it is selected.\n\nIt is a widget like any other: data and a drawing, no code. Install a widget with the id `note` to replace it.", placement: "board", size: { w: 220, h: 180 }, chrome: "card",
    icon: mark('<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>'), permissions: [], assets: {}, code: "",
    options: [{ id: "color", label: "Colour", type: "choice", values: NOTE_COLORS, default: "yellow" }],
    draw: { type: "stack", fill: true, tint: "$options.color", children: [{ type: "textarea", placeholder: "Write something" }] },
  },
  {
    id: "checklist", name: "Checklist", builtin: true, category: "productivity", commands: [], description: "A titled list of lines to tick, add and reorder.",
    readme: "# Checklist\n\nA list on the board. Double-click to write its title; press Enter for a new line, Backspace on an empty line to remove it, and drag the grip to reorder. Ticks and lines merge when two people edit at once.\n\nIt is a widget like any other. Install a widget with the id `checklist` to replace it.", placement: "board", size: { w: 260, h: 200 }, chrome: "card",
    icon: mark('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'), permissions: [], assets: {}, code: "",
    options: [],
    draw: { type: "stack", fill: true, children: [{ type: "list", title: true, placeholder: "Checklist" }] },
  },
  {
    id: "text", name: "Text", builtin: true, category: "productivity", commands: [], description: "A large text label on the board, with no card.",
    readme: "# Text\n\nA heading on the board. Double-click to write.\n\nIt is a widget like any other. Install a widget with the id `text` to replace it.", placement: "board", size: { w: 320, h: 64 }, chrome: "none",
    icon: mark('<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>'), permissions: [], assets: {}, code: "",
    options: [],
    draw: { type: "stack", fill: true, children: [{ type: "textarea", size: "large", placeholder: "Text" }] },
  },
];

/** A placed widget, as far as drawing it goes. */
export interface PlacedWidget {
  id: string;
  widget: string;
  placement?: "board" | "screen";
  text?: string;
  items?: Array<{ id: string; text: string; done: boolean }>;
  options?: Record<string, unknown>;
}

/** A placed widget's options: what the person set, else each option's default. */
export const widgetOptions = (pkg: WidgetPackage, w: PlacedWidget): Record<string, string | number | boolean> => resolveSettings(pkg.options, w.options);

/** `tree` with each "$options.<id>" string replaced by that option's value. */
function withOptions(tree: unknown, options: Record<string, unknown>, depth = 0): unknown {
  if (depth > 10) return null;
  if (typeof tree === "string") return tree.startsWith("$options.") ? options[tree.slice(9)] ?? "" : tree;
  if (Array.isArray(tree)) return tree.map((t) => withOptions(t, options, depth + 1));
  if (typeof tree === "object" && tree !== null) return Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, withOptions(v, options, depth + 1)]));
  return tree;
}

/** What a widget shows: its package's `draw` (a widget without code), else what its code drew. */
export function widgetTree(w: PlacedWidget, pkg: WidgetPackage | undefined, drawn: unknown): unknown {
  if (pkg?.draw !== undefined) return withOptions(pkg.draw, widgetOptions(pkg, w));
  return drawn ?? null;
}

/** The note colour a widget's drawing tints its card (`tint`), if any: one of the note colours,
 *  else none (any other word would draw dark ink on a card of no colour). */
export function widgetTint(tree: unknown): string | null {
  const t = (tree as { tint?: unknown } | null)?.tint;
  return typeof t === "string" && NOTE_COLORS.includes(t) ? t : null;
}

/** Why the `tint` of a drawing (`at`) colours nothing: it is set, and is not a note colour; else
 *  null. Null and "" are no tint, as is an option left empty ("$options.<id>" drawn as ""). */
export function tintProblem(tree: unknown, at = "the tree"): string | null {
  const t = (tree as { tint?: unknown } | null)?.tint;
  if (t === undefined || t === null || t === "" || widgetTint(tree)) return null;
  return `${at} has the tint ${JSON.stringify(t)}, which is not a note colour, so its card is drawn without one; the note colours: ${NOTE_COLORS.join(", ")}`;
}

const MAX_VIEW_IMAGES = 1_000_000;
/** The image names a drawing uses (an image's or sprite's `src`). */
function imagesIn(tree: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 10 || typeof tree !== "object" || tree === null) return out;
  const n = tree as { src?: unknown; children?: unknown };
  if (typeof n.src === "string") out.add(n.src);
  if (Array.isArray(n.children)) for (const c of n.children.slice(0, 50)) imagesIn(c, out, depth + 1);
  return out;
}

/** A placed widget as a view is given it (view protocol 1.8): what it draws (`drawn`: the tree its
 *  code last drew), what people wrote in it, and the images its drawing names (as many as fit in a
 *  megabyte). */
export function viewWidget(w: PlacedWidget, pkg: WidgetPackage | undefined, drawn: unknown): ViewWidget {
  const tree = widgetTree(w, pkg, drawn);
  const tint = widgetTint(tree);
  const images: Record<string, string> = {};
  let size = 0;
  for (const name of imagesIn(tree)) {
    const url = pkg && Object.hasOwn(pkg.assets, name) ? pkg.assets[name]! : null;
    if (!url || size + url.length > MAX_VIEW_IMAGES) continue;
    size += url.length;
    images[name] = url;
  }
  return {
    id: w.id, widget: w.widget, name: pkg?.name ?? w.widget, tree, card: pkg?.chrome !== "none", images,
    placement: w.placement === "board" ? "board" : "screen",
    ...(tint ? { tint } : {}), ...(typeof w.text === "string" ? { text: w.text } : {}), ...(Array.isArray(w.items) ? { items: w.items } : {}),
  };
}
