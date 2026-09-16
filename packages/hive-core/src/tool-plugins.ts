/**
 * Bundled tool plugins — metadata only.
 *
 * A "tool" here is something the workspace can spawn as a tile, and a plugin
 * may also contribute commands: the verbs it exposes to the CLI and to agents.
 * A built-in ships in the box and is available without being switched on; an
 * installed plugin is OFF until the user turns it on
 * (`settings.tools.enabledPlugins`), the rule `tool-registry.ts` encodes.
 *
 * Kinds no plugin claims (`shell`, `terminal`, an agent tile) stay unmanaged:
 * `tileKindAvailability` answers null and the caller treats that as always
 * available — a preferences blob must never be able to hide them.
 *
 * This module owns the bundled contribution list and pure answers about it. No
 * I/O, no renderer imports, no knowledge of how a tile is built.
 */
import { createToolRegistry, type RegisteredCommand, type RegisteredTool, type ToolAvailability, type ToolPluginContribution } from "./tool-registry.js";
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

export const CODE_PLUGIN_ID = "hivemind/code";
export const ISSUES_PLUGIN_ID = "hivemind/issues";

export const BUNDLED_TOOL_PLUGINS: readonly ToolPluginContribution[] = Object.freeze([
  Object.freeze({
    id: BROWSER_PLUGIN_ID,
    tools: Object.freeze([Object.freeze({ key: "browser", label: "Browser", description: "A web page in a tile, which agents can drive when you allow it.", tileKind: "browser" })]),
  }),
  Object.freeze({
    id: ISSUES_PLUGIN_ID,
    builtin: true,
    tools: Object.freeze([
      Object.freeze({ key: "issues", label: "Issues", description: "The workspace's issue list.", tileKind: "issues" }),
      Object.freeze({ key: "plan-review", label: "Plan review", description: "A plan waiting for your decision.", tileKind: "planReview" }),
    ]),
    commands: Object.freeze([
      Object.freeze({ key: "new", summary: "Open an issue", cli: "hive new \"title\" [--label X] [--parent ID] [--assignee NAME]" }),
      Object.freeze({ key: "list", summary: "List issues", readOnly: true, cli: "hive list [--state in_progress] [--json]" }),
      Object.freeze({ key: "show", summary: "Show one issue", readOnly: true, cli: "hive show <ID>" }),
      Object.freeze({ key: "update", summary: "Change an issue's state", cli: "hive update <ID> --state in_review --note \"...\"" }),
      Object.freeze({ key: "task-add", summary: "Add a subtask", cli: "hive task add <ID> \"title\"" }),
      Object.freeze({ key: "task-done", summary: "Complete a subtask", cli: "hive task done <ID> <SUBID>" }),
      Object.freeze({ key: "link", summary: "Relate two issues", cli: "hive link <ID> --parent <ID>" }),
      Object.freeze({ key: "close", summary: "Close or reopen an issue", cli: "hive close <ID>    /    hive reopen <ID>" }),
      Object.freeze({ key: "mention", summary: "Resolve a mention", readOnly: true, cli: "hive @<ID>" }),
    ]),
  }),
  Object.freeze({
    id: CODE_PLUGIN_ID,
    builtin: true,
    tools: Object.freeze([
      Object.freeze({ key: "editor", label: "Editor", description: "Open and edit files from the workspace.", tileKind: "workbench" }),
      Object.freeze({ key: "diff", label: "Diff", description: "Review what changed, and leave comments on it.", tileKind: "diff" }),
    ]),
    // The review loop an agent cannot reach from a shell: comments live in the app.
    commands: Object.freeze([
      Object.freeze({ key: "review-list", summary: "List review comments on a repository", readOnly: true, cli: "hive review list [--status open|resolved|all]" }),
      Object.freeze({ key: "review-show", summary: "Show one comment with its replies", readOnly: true, cli: "hive review show <ID>" }),
      Object.freeze({ key: "review-reply", summary: "Reply to a review comment", cli: "hive review reply <ID> \"message\"" }),
      Object.freeze({ key: "review-resolve", summary: "Mark a review comment resolved", cli: "hive review resolve <ID> --summary \"how\"" }),
      Object.freeze({ key: "review-watch", summary: "Wait for the next review comment", readOnly: true, cli: "hive review watch [--timeout S]" }),
    ]),
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
): ToolAvailability | null {
  const toolId = registry.tileKindOwner(kind);
  if (!toolId) return null; // unmanaged legacy kind
  return registry.resolve(tools).availability(toolId);
}

/** The tool id a managed tile kind belongs to (null for a legacy kind). */
export function toolIdForTileKind(tileKind: string, registry = bundledToolRegistry): string | null {
  return registry.tileKindOwner(tileKind);
}

/** Every command the enabled plugins expose, for the CLI and the MCP server. */
export function availableCommands(tools: ToolsSettings, registry = bundledToolRegistry): readonly RegisteredCommand[] {
  const resolved = registry.resolve(tools);
  return registry.commands.filter((c) => resolved.commandAvailability(c.id).available);
}
