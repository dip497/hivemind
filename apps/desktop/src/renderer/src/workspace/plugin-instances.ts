/**
 * The plugins running in this window (a view, a tool's tile, a widget with code), each with its
 * lifecycle (`@hivemind/view-host/instances`): fed by their link's host (`plugin-link.tsx`), read by
 * what an agent asks of them (`hive ctl plugin list|open|call|close`, in `Workspace.tsx`).
 */
import { PluginInstances } from "@hivemind/view-host/instances";
import { ConsoleRings } from "@hivemind/view-host/console-ring";

export const pluginInstances = new PluginInstances();
/** What each plugin tile's code wrote to the console, read by `hive ctl tile look`. */
export const consoleRings = new ConsoleRings();
