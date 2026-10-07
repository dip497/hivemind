/**
 * The commands of the plugins running in this window, for an agent (`hive ctl plugin commands`,
 * `hive ctl plugin call`): each running plugin offers what its manifest declares while it runs (the
 * active view, an open tool tile, a widget on the board), and a call reaches the one it names.
 */
import type { PluginCommand } from "@hivemind/view-sdk/commands";
import { INVOKE_ARGS_MAX } from "@hivemind/view-sdk/protocol";

export interface CommandOffer {
  plugin: string;
  kind: "view" | "tool" | "widget";
  /** Which running copy: the view's id, the tile's, the widget's. */
  instance: string;
  label: string;
  commands: readonly PluginCommand[];
  call(name: string, args: unknown): Promise<unknown>;
}

const offers = new Set<CommandOffer>();

/** Offer a running plugin's commands until the returned function is called. */
export function offerCommands(offer: CommandOffer): () => void {
  offers.add(offer);
  return () => { offers.delete(offer); };
}

/** What can be called now, by plugin. */
export function listCommands(): Array<{ plugin: string; kind: CommandOffer["kind"]; instance: string; label: string; commands: PluginCommand[] }> {
  return [...offers].map(({ plugin, kind, instance, label, commands }) => ({ plugin, kind, instance, label, commands: [...commands] }));
}

class CallError extends Error {
  constructor(readonly code: "NOT_FOUND" | "BAD_REQUEST" | "AMBIGUOUS", message: string) { super(message); }
}

/** Run `command` of the running `plugin` (its copy `instance` when several run) with `args`. */
export async function callCommand(plugin: string, command: string, args: unknown, instance?: string): Promise<unknown> {
  let size = Infinity;
  try { size = JSON.stringify(args ?? null).length; } catch { /* not JSON */ }
  if (size > INVOKE_ARGS_MAX) throw new CallError("BAD_REQUEST", `its argument must be JSON of at most ${INVOKE_ARGS_MAX} bytes`);
  const running = [...offers].filter((o) => o.plugin === plugin);
  if (!running.length) throw new CallError("NOT_FOUND", `${plugin} is not running here: open its tile, add its widget, or switch to its view`);
  const chosen = instance ? running.filter((o) => o.instance === instance) : running;
  if (!chosen.length) throw new CallError("NOT_FOUND", `${plugin} has no copy ${instance}; running: ${running.map((o) => o.instance).join(", ")}`);
  if (chosen.length > 1) throw new CallError("AMBIGUOUS", `${plugin} runs ${chosen.length} times; say which with --tile: ${chosen.map((o) => `${o.instance} (${o.label})`).join(", ")}`);
  const offer = chosen[0]!;
  if (!offer.commands.some((c) => c.name === command)) {
    throw new CallError("NOT_FOUND", `${plugin} has no command "${command}"; it has ${offer.commands.map((c) => c.name).join(", ") || "none"}`);
  }
  return offer.call(command, args ?? null);
}
