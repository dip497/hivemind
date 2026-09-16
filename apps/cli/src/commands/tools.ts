/**
 * `hive tools` — what the installed plugins contribute: the tiles they can
 * spawn, and the commands they expose to you and to agents.
 *
 *   hive tools list [--json]
 */
import { defineCommand } from "citty";
import { readSettings } from "@hivemind/core";
import { bundledToolRegistry } from "@hivemind/core/tool-plugins";
import type { ToolsSettings } from "@hivemind/core/settings-schema";
import { err, ok } from "../format.js";

const NO_PLUGINS: ToolsSettings = { enabledPlugins: [], disabledTools: [] };

const listCmd = defineCommand({
  meta: { name: "list", description: "List what each plugin contributes" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const tools = await readSettings().then((s) => s.tools).catch(() => NO_PLUGINS);
      const resolved = bundledToolRegistry.resolve(tools);
      const plugins = [...new Set(bundledToolRegistry.tools.map((t) => t.pluginId))].map((pluginId) => ({
        id: pluginId,
        tiles: bundledToolRegistry.tools
          .filter((t) => t.pluginId === pluginId)
          .map((t) => ({ id: t.id, label: t.label, tileKind: t.tileKind ?? null, available: resolved.availability(t.id).available })),
        commands: bundledToolRegistry.commands
          .filter((c) => c.pluginId === pluginId)
          .map((c) => ({ id: c.id, summary: c.summary, readOnly: c.readOnly === true, cli: c.cli ?? null, available: resolved.commandAvailability(c.id).available })),
      }));
      return ok(ctx, plugins, () =>
        plugins.map((p) => [
          p.id,
          ...p.tiles.map((t) => `  tile     ${t.label.padEnd(14)} ${t.available ? "" : "(off) "}${t.tileKind ?? ""}`),
          ...p.commands.map((c) => `  command  ${(c.cli ?? c.id).padEnd(14)} ${c.available ? "" : "(off) "}${c.readOnly ? "" : "[writes]"}`),
        ].join("\n")).join("\n\n"));
    } catch (e) {
      return err(ctx, "list_failed", e instanceof Error ? e.message : String(e));
    }
  },
});

export const toolsCmd = defineCommand({
  meta: { name: "tools", description: "Tiles and commands the plugins contribute" },
  subCommands: { list: listCmd },
});
