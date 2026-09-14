/**
 * Bundled tool plugins — metadata only.
 *
 * A "tool" here is something the workspace can spawn as a tile. Most tile kinds
 * are unmanaged legacy kinds: they predate this registry, ship with the app and
 * are always available. The managed ones are contributed by a plugin, and a
 * plugin is OFF until the user turns it on (`settings.tools.enabledPlugins`) —
 * installation alone never activates anything, which is the rule
 * `tool-registry.ts` already encodes.
 *
 * This module owns exactly two things: the bundled contribution list, and a
 * pure answer to "may the workspace offer this tile kind?". No I/O, no
 * renderer imports, no knowledge of how a tile is built.
 */
import { createToolRegistry, type RegisteredTool, type ToolAvailability, type ToolPluginContribution } from "./tool-registry.js";
// Type-only: erased at compile time, so the runtime edge stays one-way
// (settings-schema → tool-plugins, for the migration constant).
import type { ToolsSettings } from "./settings-schema.js";

/** The bundled web plugin: the Browser tile, off unless enabled. */
export const BROWSER_PLUGIN_ID = "hivemind/web";
export const BROWSER_TOOL_ID = `${BROWSER_PLUGIN_ID}/browser`;

/** What a managed tool needs beyond its registry entry: the tile kind it spawns. */
export interface ToolTileBinding {
  readonly toolId: string;
  readonly tileKind: string;
}

export const BROWSER_TOOL: ToolTileBinding = Object.freeze({ toolId: BROWSER_TOOL_ID, tileKind: "browser" });

/** Every tile kind this registry manages, and which tool id owns it. */
const MANAGED_KINDS: ReadonlyMap<string, string> = new Map([[BROWSER_TOOL.tileKind, BROWSER_TOOL.toolId]]);

export const BUNDLED_TOOL_PLUGINS: readonly ToolPluginContribution[] = Object.freeze([
  Object.freeze({
    id: BROWSER_PLUGIN_ID,
    tools: Object.freeze([Object.freeze({ key: "browser", label: "Browser", description: "A web page in a tile, which agents can drive when you allow it." })]),
  }),
]);

/** The registry for the bundled plugins. Built once — the contribution list is
 *  a module constant, so it can never fail validation at runtime. */
export const bundledToolRegistry = createToolRegistry(BUNDLED_TOOL_PLUGINS);

/** The bundled tools, for a settings UI that lists what can be enabled. */
export function bundledTools(): readonly RegisteredTool[] {
  return bundledToolRegistry.tools;
}

/**
 * Is this tile kind available under the user's tool settings?
 *
 * - `null` means the kind is NOT managed by this registry: a legacy kind that
 *   ships with the app (`shell`, `editor`, …). Those are allowed explicitly and
 *   must never be gated by a preferences blob — the caller treats null as
 *   "always available".
 * - Otherwise the registry's own answer: the plugin must be enabled AND the tool
 *   not disabled. A tool id the registry does not know reports
 *   `{available:false, reason:"not-installed"}`, so a stale `enabledPlugins`
 *   entry can never conjure a tool.
 */
export function tileKindAvailability(
  kind: string,
  tools: ToolsSettings,
  registry = bundledToolRegistry,
  managed: ReadonlyMap<string, string> = MANAGED_KINDS,
): ToolAvailability | null {
  const toolId = managed.get(kind);
  if (!toolId) return null; // unmanaged legacy kind
  return registry.resolve(tools).availability(toolId);
}

/** The tool id a managed tile kind belongs to (null for a legacy kind). */
export function toolIdForTileKind(tileKind: string, managed: ReadonlyMap<string, string> = MANAGED_KINDS): string | null {
  return managed.get(tileKind) ?? null;
}
