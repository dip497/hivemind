/** Metadata-only proof for optional tool plugins. No renderer imports or I/O. */
export interface ToolContribution {
  readonly key: string;
  readonly label: string;
}
export interface ToolPluginContribution {
  readonly id: string;
  readonly tools: readonly ToolContribution[];
}
export interface RegisteredTool extends ToolContribution {
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

export interface ToolRegistry {
  readonly tools: readonly RegisteredTool[];
  resolve(preferences: ToolPreferences): {
    readonly visible: readonly RegisteredTool[];
    availability(id: string): ToolAvailability;
  };
}

/** Call after package validation, when the installed catalog changes. Invalid
 * contributions are rejected before publication; callers retain their old catalog. */
export function createToolRegistry(plugins: readonly ToolPluginContribution[]): ToolRegistry {
  const byId = new Map<string, RegisteredTool>();
  const pluginIds = new Set<string>();
  if (plugins.length > 200) throw new Error("Too many tool plugins");
  for (const plugin of plugins) {
    if (!/^[a-z0-9][a-z0-9-]{1,39}\/[a-z0-9][a-z0-9-]{1,39}$/.test(plugin.id)) throw new Error("Invalid tool plugin id");
    if (pluginIds.has(plugin.id)) throw new Error(`Duplicate tool plugin: ${plugin.id}`);
    pluginIds.add(plugin.id);
    if (plugin.tools.length > 32) throw new Error("Too many tools in a plugin");
    for (const contribution of plugin.tools) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(contribution.key)) throw new Error("Invalid tool key");
      if (!contribution.label.trim() || contribution.label.length > 120 || /[\x00-\x1f\x7f]/.test(contribution.label)) throw new Error("Invalid tool label");
      const id = `${plugin.id}/${contribution.key}`;
      if (byId.has(id)) throw new Error(`Duplicate tool: ${id}`);
      byId.set(id, Object.freeze({ id, pluginId: plugin.id, key: contribution.key, label: contribution.label }));
    }
  }
  const tools = Object.freeze([...byId.values()]);
  return Object.freeze({
    tools,
    resolve(preferences: ToolPreferences) {
      // Snapshot sets once per preference change, never on a pointer/frame event.
      const enabled = new Set(preferences.enabledPlugins);
      const disabled = new Set(preferences.disabledTools);
      const availability = (id: string): ToolAvailability => {
        const tool = byId.get(id);
        if (!tool) return { available: false, reason: "not-installed" };
        if (!enabled.has(tool.pluginId)) return { available: false, reason: "plugin-disabled" };
        if (disabled.has(id)) return { available: false, reason: "tool-disabled" };
        return { available: true, tool };
      };
      const visible: RegisteredTool[] = [];
      for (const id of new Set(preferences.visibleTools ?? tools.map((tool) => tool.id))) {
        const result = availability(id);
        if (result.available) visible.push(result.tool);
      }
      return Object.freeze({ visible: Object.freeze(visible), availability });
    },
  });
}
