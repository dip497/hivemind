/** Metadata-only proof for optional tool plugins. No renderer imports or I/O. */
export interface ToolContribution {
  readonly key: string;
  readonly label: string;
  /** One line saying what the tool does, for the settings list. */
  readonly description?: string;
  /** Tile kind this tool spawns. Omitted by a tool that is only commands. */
  readonly tileKind?: string;
}
/** A verb a plugin exposes to agents (as an MCP tool) and to the CLI. */
export interface CommandContribution {
  readonly key: string;
  readonly summary: string;
  /** Read-only verbs run without a confirmation prompt. */
  readonly readOnly?: boolean;
  /** How to invoke it, verbatim — this is what an agent is told to type. */
  readonly cli?: string;
}
export interface ToolPluginContribution {
  readonly id: string;
  readonly tools: readonly ToolContribution[];
  readonly commands?: readonly CommandContribution[];
  /** Ships in the box: available without the user enabling it. */
  readonly builtin?: boolean;
}
export interface RegisteredTool extends ToolContribution {
  readonly id: string;
  readonly pluginId: string;
}
export interface RegisteredCommand extends CommandContribution {
  readonly id: string;
  readonly pluginId: string;
}
export interface ToolPreferences {
  /** Installation alone never activates a plugin. */
  readonly enabledPlugins: readonly string[];
  readonly disabledTools?: readonly string[];
  /** Undefined follows registry order; [] deliberately hides every shortcut. */
  readonly visibleTools?: readonly string[];
}
export type ToolAvailability =
  | { readonly available: true; readonly tool: RegisteredTool }
  | { readonly available: false; readonly reason: "not-installed" | "plugin-disabled" | "tool-disabled" };

export type CommandAvailability =
  | { readonly available: true; readonly command: RegisteredCommand }
  | { readonly available: false; readonly reason: "not-installed" | "plugin-disabled" };

export interface ToolRegistry {
  readonly tools: readonly RegisteredTool[];
  readonly commands: readonly RegisteredCommand[];
  /** Which tool id owns a tile kind — null for a kind no plugin contributes. */
  tileKindOwner(tileKind: string): string | null;
  resolve(preferences: ToolPreferences): {
    readonly visible: readonly RegisteredTool[];
    availability(id: string): ToolAvailability;
    commandAvailability(id: string): CommandAvailability;
  };
}

/** Call after package validation, when the installed catalog changes. Invalid
 * contributions are rejected before publication; callers retain their old catalog. */
export function createToolRegistry(plugins: readonly ToolPluginContribution[]): ToolRegistry {
  const byId = new Map<string, RegisteredTool>();
  const commandsById = new Map<string, RegisteredCommand>();
  const kindOwners = new Map<string, string>();
  const builtins = new Set<string>();
  const pluginIds = new Set<string>();
  if (plugins.length > 200) throw new Error("Too many tool plugins");
  for (const plugin of plugins) {
    if (!/^[a-z0-9][a-z0-9-]{1,39}\/[a-z0-9][a-z0-9-]{1,39}$/.test(plugin.id)) throw new Error("Invalid tool plugin id");
    if (pluginIds.has(plugin.id)) throw new Error(`Duplicate tool plugin: ${plugin.id}`);
    pluginIds.add(plugin.id);
    if (plugin.builtin) builtins.add(plugin.id);
    if (plugin.tools.length > 32) throw new Error("Too many tools in a plugin");
    for (const contribution of plugin.tools) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(contribution.key)) throw new Error("Invalid tool key");
      if (!contribution.label.trim() || contribution.label.length > 120 || /[\x00-\x1f\x7f]/.test(contribution.label)) throw new Error("Invalid tool label");
      const id = `${plugin.id}/${contribution.key}`;
      if (byId.has(id)) throw new Error(`Duplicate tool: ${id}`);
      const tileKind = contribution.tileKind;
      if (tileKind !== undefined) {
        if (!/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(tileKind)) throw new Error("Invalid tile kind");
        // One owner per kind: a second claimant would make spawning ambiguous.
        if (kindOwners.has(tileKind)) throw new Error(`Tile kind already contributed: ${tileKind}`);
        kindOwners.set(tileKind, id);
      }
      byId.set(id, Object.freeze({ id, pluginId: plugin.id, key: contribution.key, label: contribution.label, description: contribution.description, tileKind }));
    }
    const commands = plugin.commands ?? [];
    if (commands.length > 32) throw new Error("Too many commands in a plugin");
    for (const contribution of commands) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(contribution.key)) throw new Error("Invalid command key");
      if (!contribution.summary.trim() || contribution.summary.length > 200 || /[\x00-\x1f\x7f]/.test(contribution.summary)) throw new Error("Invalid command summary");
      // An agent is told to type this: a control character or a newline here
      // would let a contribution smuggle a second command into the context file.
      if (contribution.cli !== undefined && (contribution.cli.length > 200 || /[\x00-\x1f\x7f`]/.test(contribution.cli))) throw new Error("Invalid command cli");
      const id = `${plugin.id}/${contribution.key}`;
      if (commandsById.has(id)) throw new Error(`Duplicate command: ${id}`);
      commandsById.set(id, Object.freeze({ id, pluginId: plugin.id, key: contribution.key, summary: contribution.summary, readOnly: contribution.readOnly === true, cli: contribution.cli }));
    }
  }
  const tools = Object.freeze([...byId.values()]);
  const commands = Object.freeze([...commandsById.values()]);
  return Object.freeze({
    tools,
    commands,
    tileKindOwner: (tileKind: string) => kindOwners.get(tileKind) ?? null,
    resolve(preferences: ToolPreferences) {
      // Snapshot sets once per preference change, never on a pointer/frame event.
      const enabled = new Set(preferences.enabledPlugins);
      const disabled = new Set(preferences.disabledTools);
      // A built-in ships with the app: enabling it is not the user's chore.
      const pluginOn = (pluginId: string) => builtins.has(pluginId) || enabled.has(pluginId);
      const availability = (id: string): ToolAvailability => {
        const tool = byId.get(id);
        if (!tool) return { available: false, reason: "not-installed" };
        if (!pluginOn(tool.pluginId)) return { available: false, reason: "plugin-disabled" };
        if (disabled.has(id)) return { available: false, reason: "tool-disabled" };
        return { available: true, tool };
      };
      const commandAvailability = (id: string): CommandAvailability => {
        const command = commandsById.get(id);
        if (!command) return { available: false, reason: "not-installed" };
        if (!pluginOn(command.pluginId)) return { available: false, reason: "plugin-disabled" };
        return { available: true, command };
      };
      const visible: RegisteredTool[] = [];
      for (const id of new Set(preferences.visibleTools ?? tools.map((tool) => tool.id))) {
        const result = availability(id);
        if (result.available) visible.push(result.tool);
      }
      return Object.freeze({ visible: Object.freeze(visible), availability, commandAvailability });
    },
  });
}
