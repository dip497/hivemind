/**
 * An installed tool plugin: a folder with `hivemind-tool.json` and the ES module its tiles are
 * drawn by, which the app loads into itself. A tool plugin is trusted like the app: it runs with
 * the app's access, so one installed is off until the person switches it on.
 *
 *   {
 *     "id": "acme/prs", "name": "Pull requests", "version": "1.0.0", "apiVersion": 1,
 *     "description": "…", "entry": "index.js", "permissions": ["workspace:spawn"], "settings": [],
 *     "tools": [{ "key": "prs", "label": "Pull requests", "description": "…",
 *                 "tileKind": "acme-prs", "size": { "width": 1100, "height": 760 },
 *                 "needsRepo": true, "singleton": true, "glyph": "⇅" }]
 *   }
 *
 * The module's default export is `{ tiles: { [tileKind]: Component } }`; what the component is
 * handed is `@hivemind/tile-sdk`'s contract, versioned by `apiVersion`. `permissions` and
 * `settings` are a view's: the same `hm` client, held to the same words. No I/O here.
 */
import { VIEW_PERMISSIONS, type ViewPermission } from "@hivemind/view-sdk/protocol";
import { parseSettingFields, type SettingField } from "@hivemind/view-sdk/settings";
import { isToolId, type ToolPluginContribution } from "./tool-registry.js";

/** The version of the contract a tool plugin's module is written against. */
export const TOOL_API_VERSION = 1;

/** Tool plugin ids that only the app's own plugins may have. */
const RESERVED_OWNER = "hivemind";
const TILE_KIND = /^[a-z][a-z0-9-]{1,40}$/;

export { isToolId };
/** The folder a tool plugin lives in under the tools folder: `owner/name` as `owner--name`. */
export const toolFolder = (id: string): string => id.replace("/", "--");

/** What one tool of a package opens as. */
export interface ToolTile {
  size: { width: number; height: number };
  needsRepo: boolean;
  singleton: boolean;
  glyph?: string;
}

export interface ToolPackage extends ToolPluginContribution {
  name: string;
  description: string;
  version?: string;
  minAppVersion?: string;
  apiVersion: number;
  /** The module, relative to its folder. */
  entry: string;
  /** What its tiles' `hm` client may do. */
  permissions: ViewPermission[];
  /** What the person can set it to, read as `hm.settings`. */
  settings: SettingField[];
  /** What each tile kind it contributes opens as, by kind. */
  tiles: Record<string, ToolTile>;
  /** Its folder on this machine. */
  dir: string;
  /** Why it cannot load here; null when it can. */
  problem: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * A package from its `hivemind-tool.json`, or why it is not one. `folderId` is the id its folder
 * stands for; a manifest naming another id is refused, so a folder cannot pass for a plugin it is not.
 */
export function parseToolManifest(raw: unknown, dir: string, folderId: string | null): ToolPackage {
  if (!isObj(raw)) throw new Error("hivemind-tool.json is not an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!isToolId(id)) throw new Error(`"${id}" is not a tool plugin id: it is owner/name, like acme/prs`);
  if (id.startsWith(`${RESERVED_OWNER}/`)) throw new Error(`${RESERVED_OWNER}/ is kept for the plugins that come with the app`);
  if (folderId !== null && folderId !== id) throw new Error(`its hivemind-tool.json says it is ${id}, not ${folderId}`);
  const entry = typeof raw.entry === "string" ? raw.entry : "index.js";
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.m?js$/.test(entry) || entry.split("/").includes("..")) throw new Error(`entry "${entry}" is not a .js file inside its folder`);
  if (!Array.isArray(raw.tools) || raw.tools.length === 0) throw new Error("it lists no tools");
  if (raw.tools.length > 16) throw new Error("it lists more than 16 tools");
  const tools: { key: string; label: string; description?: string; tileKind: string }[] = [];
  const tiles: Record<string, ToolTile> = {};
  for (const t of raw.tools) {
    if (!isObj(t)) throw new Error("a tool is not an object");
    const key = typeof t.key === "string" ? t.key : "";
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) throw new Error(`tool key "${key}" is not lowercase letters, digits and dashes`);
    const kind = typeof t.tileKind === "string" ? t.tileKind : "";
    if (!TILE_KIND.test(kind)) throw new Error(`tile kind "${kind}" is not lowercase letters, digits and dashes`);
    if (tiles[kind]) throw new Error(`tile kind "${kind}" is listed twice`);
    const label = text(t.label, 60) ?? key;
    const description = text(t.description, 200);
    tools.push({ key, label, ...(description ? { description } : {}), tileKind: kind });
    const size = isObj(t.size) ? t.size : {};
    const n = (v: unknown, d: number) => (typeof v === "number" && v >= 160 && v <= 4000 ? Math.round(v) : d);
    const glyph = text(t.glyph, 2);
    tiles[kind] = {
      size: { width: n(size.width, 900), height: n(size.height, 640) },
      needsRepo: t.needsRepo === true, singleton: t.singleton === true, ...(glyph ? { glyph } : {}),
    };
  }
  // A tool switched off is stored as its key, false, beside the settings: one name, one meaning.
  const settings = parseSettingFields(raw.settings);
  const clash = settings.find((f) => tools.some((t) => t.key === f.id));
  if (clash) throw new Error(`setting "${clash.id}" has the name of one of its tools`);
  const apiVersion = typeof raw.apiVersion === "number" ? raw.apiVersion : 0;
  const version = typeof raw.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(raw.version) ? raw.version : undefined;
  const minAppVersion = text(raw.minAppVersion, 40);
  return {
    id, tools, tiles, entry, dir, apiVersion,
    permissions: Array.isArray(raw.permissions)
      ? [...new Set(raw.permissions.filter((p): p is ViewPermission => (VIEW_PERMISSIONS as readonly unknown[]).includes(p)))] : [],
    settings,
    name: text(raw.name, 60) ?? id,
    description: text(raw.description, 300) ?? "",
    ...(version ? { version } : {}),
    ...(minAppVersion ? { minAppVersion } : {}),
    problem: apiVersion === TOOL_API_VERSION ? null
      : apiVersion > TOOL_API_VERSION ? `it needs a newer app (tool API ${apiVersion}; this app has ${TOOL_API_VERSION})`
      : `it does not say which tool API it is written for ("apiVersion": ${TOOL_API_VERSION})`,
  };
}
