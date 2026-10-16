/**
 * What an agent asks of the plugins in this window (`hive ctl plugin list|open|call|close`, carried
 * here by the control plane): each answered from the plugins' lifecycle (`plugin-instances.ts`),
 * each refusal a `PluginError` whose code reaches the agent's exit status.
 */
import { PluginError } from "@hivemind/view-host/instances";
import { PLUGIN_CALL_MS, PLUGIN_OPEN_MS, type PluginInstance, type PluginList } from "@hivemind/workspace-api/plugins";
import { pluginInstances } from "./plugin-instances";
import { FALLBACK_VIEW_ID, getView, listViews } from "./workspace-view";

/** What the window does for these verbs. */
export interface PluginVerbHost {
  activeView(): string;
  showView(id: string): void;
  /** Add the widget of package `id` to the board: its id, or undefined when there is no such widget. */
  addWidget(id: string): string | undefined;
  /** Whether the widget package `id` has code: one drawn from its `draw` alone never runs. */
  widgetRuns(id: string): boolean;
  closeTile(id: string): void;
  removeWidget(id: string): void;
}

const PLUGIN_VERBS = new Set(["plugin.list", "plugin.commands", "plugin.open", "plugin.settle", "plugin.call", "plugin.close"]);
/** Whether `method` is one of these. */
export const isPluginVerb = (method: string): boolean => PLUGIN_VERBS.has(method);

/** How long `plugin close` waits for what it closed to stop. */
const CLOSE_MS = 5_000;

/** What `plugin open` adds about the plugin it got running: its copy, its state, what it offers. */
function opened(i: PluginInstance | null): Partial<PluginInstance> {
  if (!i) return {};
  return { instance: i.instance, state: i.state, ...(i.reason ? { reason: i.reason } : {}), commands: i.commands };
}

export async function pluginVerb(method: string, params: Record<string, unknown>, host: PluginVerbHost): Promise<unknown> {
  switch (method) {
    case "plugin.list": {
      const active = host.activeView();
      const answer: PluginList = {
        plugins: pluginInstances.list(),
        views: listViews().map((v) => ({ id: v.id, label: v.label, active: v.id === active })),
      };
      return answer;
    }
    case "plugin.commands":
      // Kept as it was before plugin.list: the ready plugins that offer a command.
      return {
        plugins: pluginInstances.list().filter((i) => i.state === "ready" && i.commands.length)
          .map(({ plugin, kind, instance, label, commands }) => ({ plugin, kind, instance, label, commands })),
      };
    case "plugin.open": {
      const { kind, id } = params as { kind: "widget" | "view"; id: string };
      const deadline = Date.now() + PLUGIN_OPEN_MS;
      if (kind === "view") {
        const view = getView(id);
        if (!view) throw new PluginError("NOT_FOUND", `no view ${id} here (these are: ${listViews().map((v) => v.id).join(", ")}): install it (\`hive views install <folder>\`) and switch it on (\`hive plugins enable view:${id}\`)`);
        host.showView(id);
        return { view: id, ...(view.source === "community" ? opened(await pluginInstances.settle({ plugin: id, instance: id }, deadline)) : {}) };
      }
      const widget = host.addWidget(id);
      if (!widget) throw new PluginError("NOT_FOUND", `no widget ${id} here: install it (\`hive widgets install <folder>\`) and switch it on (\`hive plugins enable widget:${id}\`)`);
      return { widget, ...(host.widgetRuns(id) ? opened(await pluginInstances.settle({ instance: widget }, deadline)) : {}) };
    }
    case "plugin.settle": {
      // A tool's tile the host just opened: answered once it can be called.
      const tile = String(params.instance ?? "");
      return opened(await pluginInstances.settle({ instance: tile }, Date.now() + PLUGIN_OPEN_MS));
    }
    case "plugin.call": {
      const c = params as { plugin: string; command: string; args: unknown; tile?: string };
      return { result: await pluginInstances.call(c.plugin, c.command, c.args, c.tile, Date.now() + PLUGIN_CALL_MS) };
    }
    case "plugin.close": {
      const instance = String(params.instance ?? "");
      const plugin = typeof params.plugin === "string" ? params.plugin : undefined;
      const found = pluginInstances.find({ instance, ...(plugin ? { plugin } : {}) });
      if (!found) {
        const running = pluginInstances.list().map((i) => `${i.instance} (${i.plugin})`);
        throw new PluginError("NOT_FOUND", `no plugin runs as ${instance}${running.length ? `; running: ${running.join(", ")}` : ""}`);
      }
      if (found.kind === "tool") host.closeTile(found.instance);
      else if (found.kind === "widget") host.removeWidget(found.instance);
      else if (host.activeView() === found.instance) host.showView(FALLBACK_VIEW_ID);
      const stopped = await pluginInstances.gone({ instance: found.instance, plugin: found.plugin }, Date.now() + CLOSE_MS);
      if (!stopped) throw new PluginError("TIMEOUT", `${found.plugin} was asked to close and is still running`);
      return { closed: found.instance, plugin: found.plugin, kind: found.kind };
    }
  }
  throw new PluginError("BAD_REQUEST", `unknown plugin verb ${method}`);
}
