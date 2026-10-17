/**
 * The plugins running in a window, as an agent drives them (`plugin.*`, 0.27): each one a tool's
 * tile, a widget with code or a community view, with one lifecycle the window keeps
 * (`docs/design/plugin-control-2026-10-16.md`):
 *
 *   starting ──connected──► ready
 *      │ did not start,         │ disabled
 *      │ disabled               ▼
 *      └──────────────────► failed
 *   any ──closed──► gone (no longer listed)
 */

/** Where a running plugin is in its life. `starting`: its code has not connected yet; `ready`: its
 *  commands can be called; `failed`: it stopped on its own, and `reason` says why. */
export type PluginState = "starting" | "ready" | "failed";

/** A command a plugin's manifest lets an agent run. */
export interface PluginCommandInfo { name: string; description: string; args?: string }

/** One plugin running in a window. */
export interface PluginInstance {
  /** Its id, as `plugin.call` names it: `owner/name` for a tool, `@owner/name` for a widget, the id for a view. */
  plugin: string;
  kind: "tool" | "widget" | "view";
  /** Which running copy: the tool's tile, the widget's id, the view's id. */
  instance: string;
  label: string;
  state: PluginState;
  /** Why it failed. */
  reason?: string;
  /** Since when it is in this state (ms since the epoch). */
  since: number;
  commands: PluginCommandInfo[];
}

/** What `plugin.list` answers: every plugin running in the window, and the views it can show. */
export interface PluginList {
  plugins: PluginInstance[];
  views: Array<{ id: string; label: string; active: boolean }>;
}

/** How long a plugin call may take in the window, from the moment it gets there: waiting for a
 *  plugin that is still starting, then its command. Each hop outside waits longer than the one
 *  within, so the innermost reason (the plugin's own, or that it was still starting) is the one
 *  the agent reads. */
export const PLUGIN_CALL_MS = 30_000;
/** How long the host waits on the window for a plugin call. */
export const PLUGIN_CALL_HOST_MS = PLUGIN_CALL_MS + 5_000;
/** How long a client waits on the host for a plugin call. */
export const PLUGIN_CALL_CLIENT_MS = PLUGIN_CALL_MS + 10_000;
/** How long `plugin.open` waits, in the window, for what it opened to be ready to call. */
export const PLUGIN_OPEN_MS = 10_000;
